import { Module } from '@nestjs/common';
import {
  PaymentsController,
  PaymentReconciliationController,
  SePayWebhookController,
} from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { SePayProvider } from './sepay.provider.js';
import { SePayWebhookGuard } from './sepay-webhook.guard.js';
import { PaymentEventsService } from './payment-events.service.js';
import { PaymentStreamController } from './payment-stream.controller.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { AdminPaymentsController } from './admin/admin-payments.controller.js';
import { AdminPaymentsService } from './admin/admin-payments.service.js';

@Module({
  imports: [SubscriptionsModule],
  controllers: [
    PaymentStreamController,
    PaymentsController,
    SePayWebhookController,
    PaymentReconciliationController,
    AdminPaymentsController,
  ],
  providers: [
    PaymentsService,
    SePayProvider,
    SePayWebhookGuard,
    PaymentEventsService,
    AdminPaymentsService,
  ],
})
export class PaymentsModule {}
