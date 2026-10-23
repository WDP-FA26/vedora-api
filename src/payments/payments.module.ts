import { Module } from '@nestjs/common';
import {
  PaymentsController,
  PaymentReconciliationController,
  SePayWebhookController,
} from './payments.controller';
import { PaymentsService } from './payments.service';
import { SePayProvider } from './sepay.provider';
import { SePayWebhookGuard } from './sepay-webhook.guard';

@Module({
  controllers: [
    PaymentsController,
    SePayWebhookController,
    PaymentReconciliationController,
  ],
  providers: [PaymentsService, SePayProvider, SePayWebhookGuard],
})
export class PaymentsModule {}
