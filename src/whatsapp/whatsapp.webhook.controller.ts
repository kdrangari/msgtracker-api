import { Body, Controller, Get, Query, Res, Post } from '@nestjs/common';
import type { Response } from 'express';
import { WhatsappService } from './whatsapp.service';

@Controller('whatsapp/webhook')
export class WhatsappWebhookController {
  constructor(private wa: WhatsappService) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response,
  ) {
    const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    if (mode === 'subscribe' && token && expected && token === expected) {
      return res.status(200).send(challenge ?? '');
    }
    return res.status(403).send('Forbidden');
  }

  @Post()
  async events(@Body() body: any) {
    await this.wa.handleWebhook(body);
    return { ok: true };
  }
}
