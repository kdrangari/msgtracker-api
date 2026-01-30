import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { google } from 'googleapis';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { extractLinks, normalizeUrl } from '../common/link.utils';

type StatePayload = { userId: string; nonce: string; iat?: number; exp?: number };

@Injectable()
export class GmailService {
  private readonly logger = new Logger(GmailService.name);

  constructor(private prisma: PrismaService) {}

  private get jwtSecret() {
    const s = process.env.APP_JWT_SECRET;
    if (!s) throw new BadRequestException('Missing APP_JWT_SECRET');
    return s;
  }

  private get oauthConfig() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      throw new BadRequestException('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI');
    }
    return { clientId, clientSecret, redirectUri };
  }

  private oauth2Client() {
    const { clientId, clientSecret, redirectUri } = this.oauthConfig;
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  async buildAuthUrl(userId: string) {
    const nonce = nanoid(16);
    const state = jwt.sign({ userId, nonce } satisfies StatePayload, this.jwtSecret, { expiresIn: '15m' });

    const client = this.oauth2Client();
    const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];

    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
      state,
    });
  }

  async handleOAuthCallback(args: { code: string; state: string }) {
    let payload: StatePayload;
    try {
      payload = jwt.verify(args.state, this.jwtSecret) as StatePayload;
    } catch {
      throw new BadRequestException('Invalid/expired state');
    }

    const client = this.oauth2Client();
    const { tokens } = await client.getToken(args.code);

    if (!tokens.refresh_token) {
      // If user already granted, Google may not return refresh_token again.
      // You can still proceed if you already have one stored.
      this.logger.warn('No refresh_token returned by Google. If this is a reconnect, existing token may be reused.');
    }

    client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const gmailAddress = profile.data.emailAddress || undefined;

    const userId = payload.userId;

    const integration = await this.prisma.integration.upsert({
      where: { userId_provider: { userId, provider: 'gmail' } },
      update: { status: 'connected', externalAccountId: gmailAddress ?? null },
      create: { userId, provider: 'gmail', status: 'connected', externalAccountId: gmailAddress ?? null },
    });

    // Store/update tokens
    const scopes = (tokens.scope || 'https://www.googleapis.com/auth/gmail.readonly').toString();

    const existingOAuth = await this.prisma.oAuthToken.findUnique({ where: { integrationId: integration.id } });
    if (existingOAuth) {
      await this.prisma.oAuthToken.update({
        where: { integrationId: integration.id },
        data: {
          refreshToken: tokens.refresh_token ? tokens.refresh_token : existingOAuth.refreshToken,
          accessToken: tokens.access_token ?? existingOAuth.accessToken,
          expiryTs: tokens.expiry_date ? new Date(tokens.expiry_date) : existingOAuth.expiryTs,
          scopes,
          tokenVersion: { increment: 1 },
        },
      });
    } else {
      if (!tokens.refresh_token) throw new BadRequestException('No refresh_token returned; reconnect with prompt=consent');
      await this.prisma.oAuthToken.create({
        data: {
          integrationId: integration.id,
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token ?? null,
          expiryTs: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          scopes,
        },
      });
    }

    // Optional: auto-setup watch
    try {
      await this.ensureWatch(userId);
    } catch (e: any) {
      this.logger.warn(`ensureWatch failed: ${e?.message ?? e}`);
    }
  }

  async getIntegrationStatus(userId: string) {
    const integration = await this.prisma.integration.findUnique({
      where: { userId_provider: { userId, provider: 'gmail' } },
      include: { oauth: true },
    });
    return {
      connected: integration?.status === 'connected',
      gmailAddress: integration?.externalAccountId ?? null,
      hasRefreshToken: Boolean(integration?.oauth?.refreshToken),
      meta: integration?.meta ?? null,
    };
  }

  private async getAuthedGmailClientByIntegrationId(integrationId: string) {
    const integration = await this.prisma.integration.findUnique({ where: { id: integrationId }, include: { oauth: true } });
    if (!integration || !integration.oauth) throw new BadRequestException('Gmail integration not connected');

    const client = this.oauth2Client();
    client.setCredentials({
      refresh_token: integration.oauth.refreshToken,
      access_token: integration.oauth.accessToken ?? undefined,
      expiry_date: integration.oauth.expiryTs?.getTime(),
    });

    // Ensure access token
    await client.getAccessToken();

    return { gmail: google.gmail({ version: 'v1', auth: client }), integration };
  }

  async ensureWatch(userId: string) {
    const topicName = process.env.GMAIL_PUBSUB_TOPIC;
    if (!topicName) throw new BadRequestException('Missing GMAIL_PUBSUB_TOPIC');

    const integration = await this.prisma.integration.findUnique({ where: { userId_provider: { userId, provider: 'gmail' } } });
    if (!integration) throw new BadRequestException('Gmail not connected');

    const { gmail } = await this.getAuthedGmailClientByIntegrationId(integration.id);

    const res = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName,
        labelIds: ['SENT'],
      },
    });

    const historyId = res.data.historyId ? String(res.data.historyId) : null;

    await this.prisma.integration.update({
      where: { id: integration.id },
      data: {
        status: 'connected',
        meta: {
          ...(typeof integration.meta === 'object' && integration.meta ? integration.meta : {}),
          watch: {
            historyId,
            expiration: res.data.expiration ? String(res.data.expiration) : null,
            labelIds: ['SENT'],
          },
        },
      },
    });

    return { ok: true, watch: res.data };
  }

  async handlePubSubPush(body: any) {
    try {
      const msg = body?.message;
      const dataB64 = msg?.data;
      if (!dataB64) return;

      const decoded = Buffer.from(String(dataB64), 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      const emailAddress: string | undefined = parsed?.emailAddress;
      const historyId: string | undefined = parsed?.historyId ? String(parsed.historyId) : undefined;

      if (!emailAddress || !historyId) return;

      const integration = await this.prisma.integration.findFirst({
        where: { provider: 'gmail', externalAccountId: emailAddress, status: 'connected' },
      });
      if (!integration) {
        this.logger.warn(`No integration found for Gmail address ${emailAddress}`);
        return;
      }

      const lastHistoryId = (integration.meta as any)?.watch?.historyId as string | undefined;
      // If we don't have startHistoryId, just update it.
      if (!lastHistoryId) {
        await this.prisma.integration.update({ where: { id: integration.id }, data: { meta: { watch: { historyId } } } });
        return;
      }

      await this.syncFromHistory({ integrationId: integration.id, startHistoryId: lastHistoryId, newHistoryId: historyId });

      // Update stored historyId to latest
      await this.prisma.integration.update({
        where: { id: integration.id },
        data: {
          meta: {
            ...(typeof integration.meta === 'object' && integration.meta ? integration.meta : {}),
            watch: {
              ...((integration.meta as any)?.watch ?? {}),
              historyId,
            },
          },
        },
      });
    } catch (e: any) {
      this.logger.error(`handlePubSubPush error: ${e?.message ?? e}`);
    }
  }

  private async syncFromHistory(args: { integrationId: string; startHistoryId: string; newHistoryId: string }) {
    const { gmail, integration } = await this.getAuthedGmailClientByIntegrationId(args.integrationId);

    // History API can return 404 if startHistoryId is too old.
    // In that case, reset and continue.
    let history: any[] = [];
    try {
      const res = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: args.startHistoryId,
        historyTypes: ['messageAdded'],
        labelId: 'SENT',
        maxResults: 100,
      });
      history = res.data.history ?? [];
    } catch (e: any) {
      this.logger.warn(`History list failed (likely too old). Resetting historyId. ${e?.message ?? e}`);
      return;
    }

    const messageIds = new Set<string>();
    for (const h of history) {
      const added = h?.messagesAdded ?? [];
      for (const ma of added) {
        const id = ma?.message?.id;
        if (id) messageIds.add(String(id));
      }
    }

    for (const messageId of messageIds) {
      await this.ingestSentMessage({ gmail, integrationUserId: integration.userId, messageId });
    }
  }

  private async ingestSentMessage(args: { gmail: any; integrationUserId: string; messageId: string }) {
    // Fetch full message so we can extract links & attachments metadata
    const res = await args.gmail.users.messages.get({ userId: 'me', id: args.messageId, format: 'full' });
    const msg = res.data;
    const labelIds: string[] = msg.labelIds ?? [];
    if (!labelIds.includes('SENT')) return;

    const headersArr = msg.payload?.headers ?? [];
    const headers: Record<string, string> = {};
    for (const h of headersArr) {
      if (h?.name && h?.value) headers[String(h.name).toLowerCase()] = String(h.value);
    }

    const subject = headers['subject'] ?? null;
    const toRecipient = headers['to'] ?? null;
    const dateHeader = headers['date'];
    const occurredAt = dateHeader ? new Date(dateHeader) : new Date(Number(msg.internalDate ?? Date.now()));

    const bodies: string[] = [];
    const attachments: Array<{ filename: string; mimeType: string; sizeBytes?: number; attachmentId: string }> = [];

    const walkParts = (part: any) => {
      if (!part) return;
      const filename = part.filename;
      const body = part.body;
      const mimeType = part.mimeType;

      if (filename && body?.attachmentId) {
        attachments.push({
          filename: String(filename),
          mimeType: String(mimeType || 'application/octet-stream'),
          sizeBytes: body?.size ? Number(body.size) : undefined,
          attachmentId: String(body.attachmentId),
        });
      }

      // Message body can appear in text/plain or text/html parts
      if (body?.data && (mimeType === 'text/plain' || mimeType === 'text/html')) {
        try {
          const text = Buffer.from(String(body.data), 'base64').toString('utf8');
          bodies.push(text);
        } catch {
          // ignore
        }
      }

      const parts = part.parts ?? [];
      for (const p of parts) walkParts(p);
    };

    walkParts(msg.payload);

    const combinedText = bodies.join('\n');
    const urls = extractLinks(combinedText);

    // Upsert event
    const created = await this.prisma.event.upsert({
      where: { provider_externalId: { provider: 'gmail', externalId: String(msg.id) } },
      update: {
        occurredAt,
        toRecipient,
        subject,
        preview: msg.snippet ?? null,
        rawRef: { threadId: msg.threadId, internalDate: msg.internalDate, id: msg.id },
      },
      create: {
        userId: args.integrationUserId,
        provider: 'gmail',
        eventType: 'email_sent',
        externalId: String(msg.id),
        occurredAt,
        toRecipient,
        subject,
        preview: msg.snippet ?? null,
        rawRef: { threadId: msg.threadId, internalDate: msg.internalDate, id: msg.id },
      },
    });

    // Links
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
        where: { eventId_linkId: { eventId: created.id, linkId: link.id } },
        update: {},
        create: { eventId: created.id, linkId: link.id },
      });
    }

    // Attachments metadata
    for (const a of attachments) {
      await this.prisma.attachment.create({
        data: {
          eventId: created.id,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes ?? null,
          externalAttachmentId: a.attachmentId,
        },
      }).catch(() => {
        // ignore duplicates if you add a unique constraint later
      });
    }
  }
}
