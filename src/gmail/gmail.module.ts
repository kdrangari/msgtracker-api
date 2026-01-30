import { Module } from '@nestjs/common';
import { GmailController } from './gmail.controller';
import { GmailWebhookController } from './gmail.webhook.controller';
import { GmailService } from './gmail.service';

@Module({
  controllers: [GmailController, GmailWebhookController],
  providers: [GmailService],
  exports: [GmailService],
})
export class GmailModule {}
