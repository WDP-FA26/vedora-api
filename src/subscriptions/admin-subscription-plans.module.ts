import { Module } from '@nestjs/common';
import { SubscriptionsModule } from './subscriptions.module.js';
import { AdminSubscriptionPlansController } from './admin-subscription-plans.controller.js';
import { SubscriptionGrantsService } from './subscription-grants.service.js';

@Module({
  imports: [SubscriptionsModule],
  controllers: [AdminSubscriptionPlansController],
  providers: [SubscriptionGrantsService],
})
export class AdminSubscriptionPlansModule {}
