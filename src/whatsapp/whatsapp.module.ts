import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappWebhookController } from './whatsapp.webhook.controller';
import { WhatsappService } from './whatsapp.service';

@Module({
  controllers: [WhatsappController, WhatsappWebhookController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
