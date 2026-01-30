import { Body, Controller, Headers, Post } from '@nestjs/common';
import { GmailService } from './gmail.service';

// Pub/Sub push endpoint for Gmail watch notifications.
// Configure your Pub/Sub subscription to push to: /gmail/webhook/pubsub
@Controller('gmail/webhook')
export class GmailWebhookController {
  constructor(private gmail: GmailService) {}

  @Post('pubsub')
  async pubsub(@Body() body: any, @Headers('x-goog-resource-state') _state: string | undefined) {
    // Pub/Sub format:
    // { message: { data: base64string, messageId, ... }, subscription }
    await this.gmail.handlePubSubPush(body);
    // Must return 200 quickly
    return { ok: true };
  }
}
