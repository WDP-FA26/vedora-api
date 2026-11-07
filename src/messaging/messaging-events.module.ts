import { Module } from '@nestjs/common';
import { MessagingEventsService } from './messaging-events.service.js';

@Module({
  providers: [MessagingEventsService],
  exports: [MessagingEventsService],
})
export class MessagingEventsModule {}
