import { BadRequestException, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { GmailService } from './gmail.service';

@Controller('gmail')
export class GmailController {
  constructor(private gmail: GmailService) {}

  @Get('auth/start')
  async start(@Req() req: Request & { user?: any }) {
    if (!req.user) throw new BadRequestException('Missing x-user-email header.');
    const url = await this.gmail.buildAuthUrl(req.user.id);
    return { url };
  }

  @Get('auth/callback')
  async callback(@Query('code') code: string | undefined, @Query('state') state: string | undefined) {
    if (!code || !state) throw new BadRequestException('Missing code/state');
    await this.gmail.handleOAuthCallback({ code, state });
    return { ok: true, message: 'Gmail connected. You can close this tab.' };
  }

  @Post('watch')
  async watch(@Req() req: Request & { user?: any }) {
    if (!req.user) throw new BadRequestException('Missing x-user-email header.');
    return this.gmail.ensureWatch(req.user.id);
  }

  @Get('status')
  async status(@Req() req: Request & { user?: any }) {
    if (!req.user) throw new BadRequestException('Missing x-user-email header.');
    return this.gmail.getIntegrationStatus(req.user.id);
  }
}
