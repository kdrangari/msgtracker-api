import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Provider } from '@prisma/client';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  async overview(args: { userId: string; from: Date; to: Date; provider?: Provider }) {
    const where: any = { userId: args.userId, occurredAt: { gte: args.from, lte: args.to } };
    if (args.provider) where.provider = args.provider;

    const totalEvents = await this.prisma.event.count({ where });

    const byProvider = await this.prisma.event.groupBy({
      by: ['provider'],
      where,
      _count: { id: true },
    });

    const byType = await this.prisma.event.groupBy({
      by: ['eventType'],
      where,
      _count: { id: true },
    });

    return {
      range: { from: args.from.toISOString(), to: args.to.toISOString() },
      totalEvents,
      byProvider,
      byType,
    };
  }

  async links(args: { userId: string; from: Date; to: Date; provider?: Provider }) {
    const where: any = { userId: args.userId, occurredAt: { gte: args.from, lte: args.to } };
    if (args.provider) where.provider = args.provider;

    const rows = await this.prisma.eventLink.findMany({
      where: { event: where },
      include: { link: true },
    });

    const counts = new Map<string, { url: string; domain: string; count: number }>();
    for (const r of rows) {
      const key = r.link.normalizedUrl;
      const cur = counts.get(key) ?? { url: r.link.url, domain: r.link.domain, count: 0 };
      cur.count += 1;
      counts.set(key, cur);
    }

    const list = Array.from(counts.entries())
      .map(([normalizedUrl, v]) => ({ normalizedUrl, ...v }))
      .sort((a, b) => b.count - a.count);

    // domain rollup
    const domainCounts = new Map<string, number>();
    for (const item of list) domainCounts.set(item.domain, (domainCounts.get(item.domain) ?? 0) + item.count);
    const domains = Array.from(domainCounts.entries())
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count);

    return { range: { from: args.from.toISOString(), to: args.to.toISOString() }, topLinks: list.slice(0, 200), topDomains: domains.slice(0, 100) };
  }

  async attachments(args: { userId: string; from: Date; to: Date; provider?: Provider }) {
    const whereEvent: any = { userId: args.userId, occurredAt: { gte: args.from, lte: args.to } };
    if (args.provider) whereEvent.provider = args.provider;

    const attachments = await this.prisma.attachment.findMany({
      where: { event: whereEvent },
      include: { event: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    const byMime = new Map<string, number>();
    for (const a of attachments) byMime.set(a.mimeType, (byMime.get(a.mimeType) ?? 0) + 1);

    const mimeSummary = Array.from(byMime.entries())
      .map(([mimeType, count]) => ({ mimeType, count }))
      .sort((a, b) => b.count - a.count);

    return {
      range: { from: args.from.toISOString(), to: args.to.toISOString() },
      totalAttachments: attachments.length,
      mimeSummary,
      items: attachments.map(a => ({
        id: a.id,
        provider: a.event.provider,
        occurredAt: a.event.occurredAt,
        to: a.event.toRecipient,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      })),
    };
  }

  async events(args: { userId: string; from: Date; to: Date; provider?: Provider; query?: string }) {
    const where: any = { userId: args.userId, occurredAt: { gte: args.from, lte: args.to } };
    if (args.provider) where.provider = args.provider;
    if (args.query) {
      where.OR = [
        { subject: { contains: args.query, mode: 'insensitive' } },
        { toRecipient: { contains: args.query, mode: 'insensitive' } },
        { preview: { contains: args.query, mode: 'insensitive' } },
      ];
    }

    const events = await this.prisma.event.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: 200,
      include: { attachments: true, eventLinks: { include: { link: true } } },
    });

    return {
      range: { from: args.from.toISOString(), to: args.to.toISOString() },
      items: events.map(e => ({
        id: e.id,
        provider: e.provider,
        eventType: e.eventType,
        externalId: e.externalId,
        occurredAt: e.occurredAt,
        to: e.toRecipient,
        subject: e.subject,
        preview: e.preview,
        links: e.eventLinks.map(l => l.link.url),
        attachments: e.attachments.map(a => ({ filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
      })),
    };
  }
}
