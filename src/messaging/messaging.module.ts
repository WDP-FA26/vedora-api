import { Module } from '@nestjs/common';
import { MessagingController } from './messaging.controller.js';
import { MessagingService } from './messaging.service.js';
import { MessagingEventsModule } from './messaging-events.module.js';

@Module({
  imports: [MessagingEventsModule],
  controllers: [MessagingController],
  providers: [MessagingService],
})
export class MessagingModule {}
