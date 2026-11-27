import { Module } from '@nestjs/common';
import { SubscriptionsModule } from './subscriptions.module.js';
import { AdminSubscriptionPlansController } from './admin-subscription-plans.controller.js';

@Module({
  imports: [SubscriptionsModule],
  controllers: [AdminSubscriptionPlansController],
})
export class AdminSubscriptionPlansModule {}
