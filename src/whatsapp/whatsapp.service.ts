import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { extractLinks, normalizeUrl } from '../common/link.utils';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(private prisma: PrismaService) {}

  private get accessToken() {
    const t = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!t) throw new BadRequestException('Missing WHATSAPP_ACCESS_TOKEN');
    return t;
  }

  private get phoneNumberId() {
    const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!id) throw new BadRequestException('Missing WHATSAPP_PHONE_NUMBER_ID');
    return id;
  }

  private get graphApiVersion() {
    return process.env.WHATSAPP_GRAPH_VERSION || 'v20.0';
  }

  private graphBaseUrl() {
    return `https://graph.facebook.com/${this.graphApiVersion}`;
  }

  async getIntegrationStatus(userId: string) {
    const integration = await this.prisma.integration.findUnique({
      where: { userId_provider: { userId, provider: 'whatsapp' } },
    });
    return {
      connected: integration?.status === 'connected',
      externalAccountId: integration?.externalAccountId ?? null,
      meta: integration?.meta ?? null,
    };
  }

  async ensureConnected(userId: string) {
    // For WhatsApp Business Platform, auth is typically app-level (system user token).
    // We still store a per-user Integration so we can attribute sends & reports.
    const integration = await this.prisma.integration.upsert({
      where: { userId_provider: { userId, provider: 'whatsapp' } },
      update: { status: 'connected', externalAccountId: this.phoneNumberId },
      create: { userId, provider: 'whatsapp', status: 'connected', externalAccountId: this.phoneNumberId },
    });
    return integration;
  }

  async sendText(args: { userId: string; to: string; text: string }) {
    await this.ensureConnected(args.userId);

    const url = `${this.graphBaseUrl()}/${this.phoneNumberId}/messages`;
    const resp = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to: args.to,
        type: 'text',
        text: { body: args.text },
      },
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
      },
    );

    const messageId = resp.data?.messages?.[0]?.id;
    if (!messageId) this.logger.warn(`No message id returned: ${JSON.stringify(resp.data)}`);

    const occurredAt = new Date();

    const event = await this.prisma.event.create({
      data: {
        userId: args.userId,
        provider: 'whatsapp',
        eventType: 'wa_sent',
        externalId: String(messageId ?? `unknown_${Date.now()}`),
        occurredAt,
        toRecipient: args.to,
        preview: args.text.slice(0, 240),
        rawRef: resp.data,
      },
    });

    await this.upsertLinksForEvent(event.id, args.text);

    return { ok: true, messageId, eventId: event.id };
  }

  async sendDocument(args: { userId: string; to: string; documentUrl: string; filename: string; caption?: string }) {
    await this.ensureConnected(args.userId);

    const url = `${this.graphBaseUrl()}/${this.phoneNumberId}/messages`;
    const resp = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to: args.to,
        type: 'document',
        document: { link: args.documentUrl, filename: args.filename, caption: args.caption },
      },
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
      },
    );

    const messageId = resp.data?.messages?.[0]?.id;
    const occurredAt = new Date();

    const event = await this.prisma.event.create({
      data: {
        userId: args.userId,
        provider: 'whatsapp',
        eventType: 'wa_sent',
        externalId: String(messageId ?? `unknown_${Date.now()}`),
        occurredAt,
        toRecipient: args.to,
        preview: `${args.filename}${args.caption ? ` – ${args.caption}` : ''}`.slice(0, 240),
        rawRef: resp.data,
      },
    });

    // Attachment metadata (document URL is not stored in Attachment table by design — only metadata)
    await this.prisma.attachment.create({
      data: {
        eventId: event.id,
        filename: args.filename,
        mimeType: 'application/octet-stream',
        sizeBytes: null,
        externalAttachmentId: args.documentUrl,
      },
    });

    if (args.caption) await this.upsertLinksForEvent(event.id, args.caption);
    await this.upsertLinksForEvent(event.id, args.documentUrl);

    return { ok: true, messageId, eventId: event.id };
  }

  async handleWebhook(body: any) {
    // Store delivery/read statuses.
    try {
      const entries = body?.entry ?? [];
      for (const entry of entries) {
        const changes = entry?.changes ?? [];
        for (const ch of changes) {
          const value = ch?.value;
          const statuses = value?.statuses ?? [];
          for (const st of statuses) {
            const msgId = st?.id;
            const status = st?.status;
            const ts = st?.timestamp ? new Date(Number(st.timestamp) * 1000) : new Date();
            if (!msgId || !status) continue;

            // We can't map to user reliably without storing per-user correlation.
            // Approach: find wa_sent event with externalId == msgId.
            const sent = await this.prisma.event.findFirst({ where: { provider: 'whatsapp', eventType: 'wa_sent', externalId: String(msgId) } });
            if (!sent) continue;

            await this.prisma.event.create({
              data: {
                userId: sent.userId,
                provider: 'whatsapp',
                eventType: 'wa_status',
                externalId: `${msgId}:${status}:${st?.recipient_id ?? ''}`,
                occurredAt: ts,
                toRecipient: st?.recipient_id ?? sent.toRecipient,
                preview: status,
                rawRef: st,
              },
            }).catch(() => undefined);
          }
        }
      }
    } catch (e: any) {
      this.logger.error(`handleWebhook error: ${e?.message ?? e}`);
    }
  }

  private async upsertLinksForEvent(eventId: string, text: string) {
    const urls = extractLinks(text);
    for (const u of urls) {
      const nu = normalizeUrl(u);
      if (!nu) continue;
      const domain = (() => {
        try {
          return new URL(nu).hostname;
        } catch {
          return 'unknown';
        }
      })();

      const link = await this.prisma.link.upsert({
        where: { normalizedUrl: nu },
        update: { url: u, domain },
        create: { url: u, normalizedUrl: nu, domain },
      });

      await this.prisma.eventLink.upsert({
        where: { eventId_linkId: { eventId, linkId: link.id } },
        update: {},
        create: { eventId, linkId: link.id },
      });
    }
  }
}
