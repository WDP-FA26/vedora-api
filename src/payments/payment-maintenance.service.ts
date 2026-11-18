import { runtimeConfig } from '../config/runtime-config.js';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PaymentsService } from './payments.service.js';

@Injectable()
export class PaymentMaintenanceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentMaintenanceService.name);

  constructor(private readonly payments: PaymentsService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.expireOrders();
  }

  @Cron(runtimeConfig.PAYMENT_EXPIRATION_CRON, { waitForCompletion: true })
  async expireOrders(): Promise<void> {
    try {
      await this.payments.expirePending();
    } catch (error) {
      this.logger.error(
        'Payment expiration sweep failed; the next sweep will retry',
        error,
      );
    }
  }
}
