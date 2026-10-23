import { Module } from '@nestjs/common';
import {
  PaymentsController,
  PaymentReconciliationController,
  SePayWebhookController,
} from './payments.controller';
import { PaymentsService } from './payments.service';
import { SePayProvider } from './sepay.provider';
import { SePayWebhookGuard } from './sepay-webhook.guard';
import { PaymentEventsService } from './payment-events.service';
import { PaymentStreamController } from './payment-stream.controller';

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
