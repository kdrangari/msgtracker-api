import { BadRequestException, Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private reports: ReportsService) {}

  private parseRange(q: any) {
    const schema = z.object({ from: z.string().optional(), to: z.string().optional(), provider: z.enum(['gmail', 'whatsapp']).optional() });
    const { from, to, provider } = schema.parse(q);
    const fromD = from ? new Date(from) : new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const toD = to ? new Date(to) : new Date();
    return { from: fromD, to: toD, provider };
  }

  @Get('overview')
  async overview(@Req() req: Request & { user?: any }, @Query() q: any) {
    if (!req.user) throw new BadRequestException('Missing x-user-email header.');
    const { from, to, provider } = this.parseRange(q);
    return this.reports.overview({ userId: req.user.id, from, to, provider });
  }

  @Get('links')
  async links(@Req() req: Request & { user?: any }, @Query() q: any) {
    if (!req.user) throw new BadRequestException('Missing x-user-email header.');
    const { from, to, provider } = this.parseRange(q);
    return this.reports.links({ userId: req.user.id, from, to, provider });
  }

  @Get('attachments')
  async attachments(@Req() req: Request & { user?: any }, @Query() q: any) {
    if (!req.user) throw new BadRequestException('Missing x-user-email header.');
    const { from, to, provider } = this.parseRange(q);
    return this.reports.attachments({ userId: req.user.id, from, to, provider });
  }

  @Get('events')
  async events(@Req() req: Request & { user?: any }, @Query() q: any) {
    if (!req.user) throw new BadRequestException('Missing x-user-email header.');
    const schema = z.object({ from: z.string().optional(), to: z.string().optional(), provider: z.enum(['gmail', 'whatsapp']).optional(), q: z.string().optional() });
    const parsed = schema.parse(q);
    const from = parsed.from ? new Date(parsed.from) : new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const to = parsed.to ? new Date(parsed.to) : new Date();
    return this.reports.events({ userId: req.user.id, from, to, provider: parsed.provider, query: parsed.q });
  }
}
