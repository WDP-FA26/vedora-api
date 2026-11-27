import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiUsageService } from './ai-usage.service.js';
import { SubscriptionsService } from './subscriptions.service.js';
import { SubscriptionCatalogService } from './subscription-catalog.service.js';

@Module({
  imports: [ConfigModule],
  providers: [SubscriptionsService, AiUsageService, SubscriptionCatalogService],
  exports: [SubscriptionsService, AiUsageService, SubscriptionCatalogService],
})
export class SubscriptionsModule {}
