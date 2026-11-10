import { Module } from '@nestjs/common';
import { AiUsageService } from './ai-usage.service.js';
import { SubscriptionsService } from './subscriptions.service.js';

@Module({
  providers: [SubscriptionsService, AiUsageService],
  exports: [SubscriptionsService, AiUsageService],
})
export class SubscriptionsModule {}
