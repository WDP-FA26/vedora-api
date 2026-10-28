import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession } from 'mongodb';
import type { Model } from 'mongoose';
import { lockDocument } from '../mongo/document-lock';
import { isUniqueViolation } from '../mongo/errors';
import {
  AccountStatus,
  BillingPlan,
  PaymentIntent,
  PaymentStatus,
  type PaymentRequest,
  type PaymentWebhookReceipt,
  type Stored,
  type User,
} from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';
import {
  BillingCatalogDto,
  BillingOverviewDto,
  PaymentDto,
} from './payment.dto';
import { SePayProvider } from './sepay.provider';
import { parseBankWebhook } from './sepay-payload';
import { generatePaymentCode } from './payment-code';
import { PaymentChanged, PaymentEventsService } from './payment-events.service';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const membershipExpiry = (startsAt: Date, durationDays: number) =>
  new Date(startsAt.getTime() + durationDays * 86_400_000);
/** A payment intent as the service passes it around: `id` is its `_id`. */
type Intent = Omit<PaymentIntent, '_id'>;
const conflict = (code: string, message: string): never => {
  throw new ConflictException({ code, message });
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  constructor(
    private readonly mongo: MongoService,
    @InjectModel(PaymentIntent.name)
    private readonly intents: Model<PaymentIntent>,
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

  /** Overlapping transactions on one key conflict, and the driver retries. */
  private async lock(
    session: ClientSession,
    kind: 'payer' | 'transaction',
    id: string,
  ) {
    await lockDocument(this.mongo.db, session, kind, id);
  }

  /** The driver collections the payment transactions write. */
  private get collections() {
    const { db } = this.mongo;
    return {
      intents: db.collection<Stored<PaymentIntent>>('payment_intents'),
      requests: db.collection<Stored<PaymentRequest>>('payment_requests'),
      receipts: db.collection<Stored<PaymentWebhookReceipt>>(
        'payment_webhook_receipts',
      ),
      users: db.collection<Stored<User>>('users'),
    };
  }

  private toIntent({ _id, ...intent }: Stored<PaymentIntent>): Intent {
    return { id: _id, ...intent };
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

  serialize(intent: Intent): PaymentDto {
    return {
      id: intent.id,
      planCode: intent.planCode,
      durationDays: intent.durationDays,
      amount: intent.amount.toString(),
      currency: intent.currency,
      status: intent.status,
      invoiceNumber: intent.invoiceNumber,
      paymentCode: intent.paymentCode,
      createdAt: intent.createdAt.toISOString(),
      paidAt: intent.paidAt?.toISOString() ?? null,
      capturedAt: intent.capturedAt?.toISOString() ?? null,
      cancelledAt: intent.cancelledAt?.toISOString() ?? null,
      qr:
        intent.status === PaymentStatus.PENDING &&
        this.catalog().paymentsEnabled
          ? this.provider.qr(intent, intent.amount.toString())
          : null,
    };
  }

  async overview(userId: string): Promise<BillingOverviewDto> {
    const now = new Date();
    // The latest capture is the membership; a new purchase replaces it.
    const [latest, pending, recent] = await Promise.all([
      this.intents
        .findOne({ userId, status: PaymentStatus.SUCCEEDED })
        .sort({ capturedAt: -1, _id: -1 })
        .exec(),
      this.intents.findOne({ activeIntentKey: userId }).exec(),
      this.intents
        .find({ userId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(20)
        .exec(),
    ]);
    const membership = latest?.capturedAt
      ? {
          planCode: latest.planCode,
          startsAt: latest.capturedAt,
          expiresAt: membershipExpiry(latest.capturedAt, latest.durationDays),
        }
      : null;
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
  }

  async get(id: string, userId: string): Promise<PaymentDto> {
    const intent = await this.intents.findOne({ _id: id, userId }).exec();
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
    const { intents, requests, users } = this.collections;
    const attemptCreate = () =>
      this.mongo.withTransaction(async (session) => {
        await this.lock(session, 'payer', userId);
        const prior = await requests.findOne(
          { actorId: userId, requestKey: key },
          { session },
        );
        if (prior) {
          if (prior.payloadHash !== payloadHash)
            conflict(
              'IDEMPOTENCY_CONFLICT',
              'This key was used with another request',
            );
          const priorIntent = await intents.findOne(
            { _id: prior.intentId },
            { session },
          );
          if (!priorIntent) throw new NotFoundException('Payment not found');
          return this.toIntent(priorIntent);
        }
        const user = await users.findOne({ _id: userId }, { session });
        if (
          !user ||
          user.status !== AccountStatus.ACTIVE ||
          !user.emailVerifiedAt
        )
          conflict(
            'ACCOUNT_NOT_PAYABLE',
            'A verified active account is required',
          );
        const plan = this.catalog().plans.find(
          (item) => item.code === planCode,
        );
        if (!plan) throw new BadRequestException('Unknown billing plan');
        const pending = await intents.findOne(
          { activeIntentKey: userId },
          { session },
        );
        let intent: Intent | undefined = pending
          ? this.toIntent(pending)
          : undefined;
        if (
          intent &&
          (intent.planCode !== planCode ||
            intent.amount.toString() !== plan.priceVnd ||
            intent.durationDays !== plan.durationDays)
        )
          conflict(
            'PENDING_PAYMENT_CONFLICT',
            'Continue or cancel the pending payment before creating a different purchase',
          );
        const now = new Date();
        if (!intent) {
          const paymentCode = generatePaymentCode(
            this.config.get<string>('SEPAY_PAYMENT_CODE_PREFIX', 'VED'),
          );
          intent = {
            id: randomUUID(),
            userId,
            planCode,
            amount: BigInt(plan.priceVnd),
            durationDays: plan.durationDays,
            currency: 'VND',
            status: PaymentStatus.PENDING,
            activeIntentKey: userId,
            paymentCode,
            invoiceNumber: `VED-${randomBytes(16).toString('hex').toUpperCase()}`,
            ...this.provider.snapshot(paymentCode),
            providerTransactionId: null,
            providerReference: null,
            paidAt: null,
            capturedAt: null,
            cancelledAt: null,
            createdAt: now,
            updatedAt: now,
          };
          const { id: _id, ...document } = intent;
          await intents.insertOne({ _id, ...document }, { session });
        }
        await requests.insertOne(
          {
            _id: randomUUID(),
            actorId: userId,
            requestKey: key,
            payloadHash,
            intentId: intent.id,
            createdAt: now,
          },
          { session },
        );
        return intent;
      });
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return this.serialize(await attemptCreate());
      } catch (error) {
        // A duplicate payment code aborts the transaction: retry the whole
        // transaction with a new code. The driver already retried write
        // conflicts. Other errors escape.
        const codeTaken =
          isUniqueViolation(error) && 'paymentCode' in (error.keyPattern ?? {});
        if (!codeTaken) throw error;
      }
    }
    throw new ServiceUnavailableException({
      code: 'PAYMENT_CODE_UNAVAILABLE',
      message:
        'Could not allocate a payment code; retry with the same Idempotency-Key',
    });
  }

  async cancel(id: string, userId: string): Promise<PaymentDto> {
    let changed = false;
    const { intents } = this.collections;
    const intent = await this.mongo.withTransaction(async (session) => {
      await this.lock(session, 'payer', userId);
      const current = await intents.findOne({ _id: id, userId }, { session });
      if (!current) throw new NotFoundException('Payment not found');
      if (current.status === PaymentStatus.CANCELLED)
        return this.toIntent(current);
      if (current.status !== PaymentStatus.PENDING)
        conflict(
          'PAYMENT_NOT_PENDING',
          'A completed payment cannot be cancelled or refunded here',
        );
      const now = new Date();
      const updated = await intents.findOneAndUpdate(
        { _id: id },
        {
          $set: {
            status: PaymentStatus.CANCELLED,
            activeIntentKey: null,
            cancelledAt: now,
            updatedAt: now,
          },
        },
        { session, returnDocument: 'after' },
      );
      if (!updated) throw new NotFoundException('Payment not found');
      changed = true;
      return this.toIntent(updated);
    });
    if (changed) await this.notifyCommitted({ userId, intentId: id });
    return this.serialize(intent);
  }

  async bankWebhook(body: unknown): Promise<void> {
    const event = parseBankWebhook(body);
    const payloadHash = hash(event);
    let changed: PaymentChanged | undefined;
    const { intents, receipts, users } = this.collections;
    await this.mongo.withTransaction(async (session) => {
      // Event lock precedes payer lock consistently. Unique indexes are the final guard.
      await this.lock(session, 'transaction', event.providerTransactionId);
      const record = async (outcome: string, intentId?: string) => {
        await receipts.insertOne(
          {
            _id: randomUUID(),
            providerTransactionId: event.providerTransactionId,
            payloadHash,
            outcome,
            intentId: intentId ?? null,
            createdAt: new Date(),
          },
          { session },
        );
      };
      if (event.transferType !== 'in') return record('NOT_INCOMING');
      const paymentCode = event.code?.trim().toUpperCase();
      if (!paymentCode) return record('PAYMENT_CODE_MISSING');
      const found = await intents.findOne({ paymentCode }, { session });
      if (!found) return record('PAYMENT_INTENT_NOT_FOUND');
      await this.lock(session, 'payer', found.userId);
      const intent = await intents.findOne({ _id: found._id }, { session });
      if (!intent) return record('PAYMENT_INTENT_NOT_FOUND');
      if (
        event.gateway.toLowerCase() !== intent.bankGateway.toLowerCase() ||
        (event.accountNumber !== intent.accountNumber &&
          event.subAccount !== intent.accountNumber)
      )
        return record('ACCOUNT_MISMATCH', intent._id);
      // The raw driver may hand back a number for an Int64 that fits 2^53,
      // while models read the same column as `bigint`.
      if (BigInt(intent.amount) !== BigInt(event.transferAmount))
        return record('AMOUNT_MISMATCH', intent._id);
      const used = await intents.findOne(
        { providerTransactionId: event.providerTransactionId },
        { session, projection: { _id: 1 } },
      );
      if (used)
        return record(
          used._id === intent._id ? 'DUPLICATE' : 'TRANSACTION_ALREADY_USED',
          intent._id,
        );
      if (intent.status !== PaymentStatus.PENDING)
        return record(
          intent.status === PaymentStatus.SUCCEEDED
            ? 'PAYMENT_INTENT_ALREADY_SUCCEEDED'
            : 'PAYMENT_CANCELLED',
          intent._id,
        );
      const user = await users.findOne({ _id: intent.userId }, { session });
      if (
        !user ||
        user.status !== AccountStatus.ACTIVE ||
        !user.emailVerifiedAt
      )
        return record('ACCOUNT_UNAVAILABLE', intent._id);
      const capturedAt = new Date();
      const claimed = await intents.updateOne(
        { _id: intent._id, status: PaymentStatus.PENDING },
        {
          $set: {
            status: PaymentStatus.SUCCEEDED,
            activeIntentKey: null,
            providerTransactionId: event.providerTransactionId,
            providerReference: event.referenceCode,
            paidAt: event.paidAt,
            capturedAt,
            updatedAt: capturedAt,
          },
        },
        { session },
      );
      if (claimed.modifiedCount !== 1)
        conflict('CAPTURE_CONFLICT', 'Payment changed; retry callback');
      await record('CAPTURED', intent._id);
      changed = { userId: intent.userId, intentId: intent._id };
    });
    if (changed) await this.notifyCommitted(changed);
  }
}
