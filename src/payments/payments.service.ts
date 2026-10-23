import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingPlan, PaymentIntent, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  BillingCatalogDto,
  BillingOverviewDto,
  PaymentDto,
} from './payment.dto';
import { SePayProvider } from './sepay.provider';
import { parseBankWebhook } from './sepay-payload';
import { PaymentChanged, PaymentEventsService } from './payment-events.service';

type Tx = Prisma.TransactionClient;
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = (code: string, message: string): never => {
  throw new ConflictException({ code, message });
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
    private readonly provider: SePayProvider,
    private readonly events: PaymentEventsService,
  ) {}

  catalog(): BillingCatalogDto {
    return {
      paymentsEnabled: this.config.get<boolean>('SEPAY_PAYMENT_ENABLED', false),
      plans: [BillingPlan.PRO, BillingPlan.PREMIUM].map((code) => ({
        code,
        name: code === BillingPlan.PRO ? 'Pro' : 'Premium',
        priceVnd: String(
          this.config.get<number>(
            `BILLING_${code}_PRICE_VND`,
            code === BillingPlan.PRO ? 49000 : 99000,
          ),
        ),
        durationDays: this.config.get<number>('BILLING_DURATION_DAYS', 30),
      })),
    };
  }

  private async lock(tx: Tx, key: string) {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  private async notifyCommitted(change: PaymentChanged): Promise<void> {
    try {
      await this.events.publish(change);
    } catch {
      this.logger.warn(
        'Payment committed; realtime notification failed. Reconcile via GET.',
      );
    }
  }

  serialize(intent: PaymentIntent): PaymentDto {
    return {
      id: intent.id,
      planCode: intent.planCode,
      durationDays: intent.durationDays,
      amount: intent.amount.toFixed(0),
      currency: intent.currency,
      status: intent.status,
      invoiceNumber: intent.invoiceNumber,
      paymentCode: intent.paymentCode,
      createdAt: intent.createdAt.toISOString(),
      paidAt: intent.paidAt?.toISOString() ?? null,
      capturedAt: intent.capturedAt?.toISOString() ?? null,
      cancelledAt: intent.cancelledAt?.toISOString() ?? null,
      qr:
        intent.status === 'PENDING' && this.catalog().paymentsEnabled
          ? this.provider.qr(intent, intent.amount.toFixed(0))
          : null,
    };
  }

  async overview(userId: string): Promise<BillingOverviewDto> {
    return this.db.$transaction(
      async (tx) => {
        const now = new Date();
        const membership = await tx.membership.findUnique({
          where: { userId },
        });
        const pending = await tx.paymentIntent.findUnique({
          where: { activeIntentKey: userId },
        });
        const recent = await tx.paymentIntent.findMany({
          where: { userId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 20,
        });
        return {
          membership:
            membership && membership.expiresAt > now
              ? {
                  planCode: membership.planCode,
                  startsAt: membership.startsAt.toISOString(),
                  expiresAt: membership.expiresAt.toISOString(),
                }
              : { planCode: 'FREE', startsAt: null, expiresAt: null },
          pendingPayment: pending ? this.serialize(pending) : null,
          recentPayments: recent.map((intent) => this.serialize(intent)),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async get(id: string, userId: string): Promise<PaymentDto> {
    const intent = await this.db.paymentIntent.findFirst({
      where: { id, userId },
    });
    if (!intent) throw new NotFoundException('Payment not found');
    return this.serialize(intent);
  }

  async create(
    userId: string,
    planCode: BillingPlan,
    key?: string,
  ): Promise<PaymentDto> {
    this.provider.assertEnabled();
    if (!key || !/^[A-Za-z0-9._:-]{8,200}$/.test(key))
      throw new BadRequestException('A valid Idempotency-Key is required');
    const payloadHash = hash({ planCode });
    const result = await this.db.$transaction(async (tx) => {
      await this.lock(tx, `payer:${userId}`);
      const prior = await tx.paymentRequest.findUnique({
        where: { actorId_requestKey: { actorId: userId, requestKey: key } },
        include: { intent: true },
      });
      if (prior) {
        if (prior.payloadHash !== payloadHash)
          conflict(
            'IDEMPOTENCY_CONFLICT',
            'This key was used with another request',
          );
        return prior.intent;
      }
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || user.status !== 'ACTIVE' || !user.emailVerifiedAt)
        conflict(
          'ACCOUNT_NOT_PAYABLE',
          'A verified active account is required',
        );
      const plan = this.catalog().plans.find((item) => item.code === planCode);
      if (!plan) throw new BadRequestException('Unknown billing plan');
      let intent = await tx.paymentIntent.findUnique({
        where: { activeIntentKey: userId },
      });
      if (
        intent &&
        (intent.planCode !== planCode ||
          intent.amount.toFixed(0) !== plan.priceVnd ||
          intent.durationDays !== plan.durationDays)
      )
        conflict(
          'PENDING_PAYMENT_CONFLICT',
          'Continue or cancel the pending payment before creating a different purchase',
        );
      if (!intent) {
        const paymentCode =
          this.config.get<string>('SEPAY_PAYMENT_CODE_PREFIX', 'VED') +
          randomBytes(10).toString('hex').toUpperCase();
        intent = await tx.paymentIntent.create({
          data: {
            userId,
            planCode,
            amount: plan.priceVnd,
            durationDays: plan.durationDays,
            activeIntentKey: userId,
            paymentCode,
            invoiceNumber: `VED-${randomBytes(16).toString('hex').toUpperCase()}`,
            ...this.provider.snapshot(paymentCode),
          },
        });
        await tx.paymentAudit.create({
          data: { intentId: intent.id, actorId: userId, action: 'CREATED' },
        });
      }
      await tx.paymentRequest.create({
        data: {
          actorId: userId,
          requestKey: key,
          payloadHash,
          intentId: intent.id,
        },
      });
      return intent;
    });
    return this.serialize(result);
  }

  async cancel(id: string, userId: string): Promise<PaymentDto> {
    let changed = false;
    const intent = await this.db.$transaction(async (tx) => {
      await this.lock(tx, `payer:${userId}`);
      const current = await tx.paymentIntent.findFirst({
        where: { id, userId },
      });
      if (!current) throw new NotFoundException('Payment not found');
      if (current.status === 'CANCELLED') return current;
      if (current.status !== 'PENDING')
        conflict(
          'PAYMENT_NOT_PENDING',
          'A completed payment cannot be cancelled or refunded here',
        );
      const updated = await tx.paymentIntent.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          activeIntentKey: null,
          cancelledAt: new Date(),
        },
      });
      await tx.paymentAudit.create({
        data: { intentId: id, actorId: userId, action: 'CANCELLED' },
      });
      changed = true;
      return updated;
    });
    if (changed) await this.notifyCommitted({ userId, intentId: id });
    return this.serialize(intent);
  }

  async bankWebhook(body: unknown): Promise<void> {
    const event = parseBankWebhook(body);
    const payloadHash = hash(event);
    let changed: PaymentChanged | undefined;
    await this.db.$transaction(async (tx) => {
      // Event lock precedes payer lock consistently. Unique DB keys are the final guard.
      await this.lock(tx, `transaction:${event.providerTransactionId}`);
      const record = async (outcome: string, intentId?: string) => {
        await tx.paymentWebhookReceipt.create({
          data: {
            providerTransactionId: event.providerTransactionId,
            payloadHash,
            outcome,
            intentId,
          },
        });
      };
      if (event.transferType !== 'in') return record('NOT_INCOMING');
      if (!event.code?.trim()) return record('PAYMENT_CODE_MISSING');
      const found = await tx.paymentIntent.findUnique({
        where: { paymentCode: event.code.trim().toUpperCase() },
      });
      if (!found) return record('PAYMENT_INTENT_NOT_FOUND');
      await this.lock(tx, `payer:${found.userId}`);
      const intent = await tx.paymentIntent.findUniqueOrThrow({
        where: { id: found.id },
      });
      if (
        event.gateway.toLowerCase() !== intent.bankGateway.toLowerCase() ||
        (event.accountNumber !== intent.accountNumber &&
          event.subAccount !== intent.accountNumber)
      )
        return record('ACCOUNT_MISMATCH', intent.id);
      if (!intent.amount.equals(String(event.transferAmount)))
        return record('AMOUNT_MISMATCH', intent.id);
      const used = await tx.paymentLedger.findUnique({
        where: { providerTransactionId: event.providerTransactionId },
      });
      if (used)
        return record(
          used.intentId === intent.id
            ? 'DUPLICATE'
            : 'TRANSACTION_ALREADY_USED',
          intent.id,
        );
      if (intent.status !== 'PENDING')
        return record(
          intent.status === 'SUCCEEDED'
            ? 'PAYMENT_INTENT_ALREADY_SUCCEEDED'
            : 'PAYMENT_CANCELLED',
          intent.id,
        );
      const user = await tx.user.findUnique({ where: { id: intent.userId } });
      if (!user || user.status !== 'ACTIVE' || !user.emailVerifiedAt)
        return record('ACCOUNT_UNAVAILABLE', intent.id);
      const capturedAt = new Date();
      const expiresAt = new Date(
        capturedAt.getTime() + intent.durationDays * 86_400_000,
      );
      const claimed = await tx.paymentIntent.updateMany({
        where: { id: intent.id, status: 'PENDING' },
        data: {
          status: 'SUCCEEDED',
          activeIntentKey: null,
          providerTransactionId: event.providerTransactionId,
          providerReference: event.referenceCode,
          paidAt: event.paidAt,
          capturedAt,
        },
      });
      if (claimed.count !== 1)
        conflict('CAPTURE_CONFLICT', 'Payment changed; retry callback');
      await tx.paymentLedger.create({
        data: {
          intentId: intent.id,
          userId: intent.userId,
          providerTransactionId: event.providerTransactionId,
          amount: intent.amount,
          planCode: intent.planCode,
          startsAt: capturedAt,
          expiresAt,
        },
      });
      const membership = {
        planCode: intent.planCode,
        startsAt: capturedAt,
        expiresAt,
        paymentId: intent.id,
      };
      await tx.membership.upsert({
        where: { userId: intent.userId },
        create: { userId: intent.userId, ...membership },
        update: membership,
      });
      await tx.paymentAudit.create({
        data: { intentId: intent.id, action: 'CAPTURED' },
      });
      await record('CAPTURED', intent.id);
      changed = { userId: intent.userId, intentId: intent.id };
    });
    if (changed) await this.notifyCommitted(changed);
  }
}
