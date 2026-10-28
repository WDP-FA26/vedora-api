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

@Module({
  controllers: [
    PaymentStreamController,
    PaymentsController,
    SePayWebhookController,
    PaymentReconciliationController,
  ],
  providers: [
    PaymentsService,
    SePayProvider,
    SePayWebhookGuard,
    PaymentEventsService,
  ],
})
export class PaymentsModule {}
