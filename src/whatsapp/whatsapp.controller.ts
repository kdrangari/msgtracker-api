import { BadRequestException, Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { WhatsappService } from './whatsapp.service';

@Controller('whatsapp')
export class WhatsappController {
  constructor(private wa: WhatsappService) {}

  @Get('status')
  async status(@Req() req: Request & { user?: any }) {
    if (!req.user) throw new BadRequestException('Missing x-user-email header.');
    return this.wa.getIntegrationStatus(req.user.id);
  }

  @Post('send/text')
  async sendText(@Req() req: Request & { user?: any }, @Body() body: any) {
    if (!req.user) throw new BadRequestException('Missing x-user-email header.');
    const parsed = z.object({ to: z.string().min(6), text: z.string().min(1).max(4096) }).parse(body);
    return this.wa.sendText({ userId: req.user.id, to: parsed.to, text: parsed.text });
  }

  @Post('send/document')
  async sendDocument(@Req() req: Request & { user?: any }, @Body() body: any) {
    if (!req.user) throw new BadRequestException('Missing x-user-email header.');
    const parsed = z
      .object({
        to: z.string().min(6),
        documentUrl: z.string().url(),
        filename: z.string().min(1),
        caption: z.string().max(1024).optional(),
      })
      .parse(body);
    return this.wa.sendDocument({ userId: req.user.id, to: parsed.to, documentUrl: parsed.documentUrl, filename: parsed.filename, caption: parsed.caption });
  }
}
