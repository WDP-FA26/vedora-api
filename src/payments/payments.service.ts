import { runtimeConfig } from '../config/runtime-config.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { lockDocument } from '../mongo/document-lock.js';
import { isUniqueViolation } from '../mongo/errors.js';
import {
  AccountStatus,
  AiFeature,
  BillingPlan,
  PaymentIntent,
  PaymentRequest,
  PaymentStatus,
  PaymentWebhookReceipt,
  User,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import {
  BillingCatalogDto,
  BillingOverviewDto,
  PaymentDto,
} from './payment.dto.js';
import { SePayProvider } from './sepay.provider.js';
import { parseBankWebhook } from './sepay-payload.js';
import { generatePaymentCode } from './payment-code.js';
import {
  expiredPaymentFilter,
  paymentExpiresAt,
  PAYMENT_LIFETIME_MS,
} from './payment-expiration.js';
import {
  effectivePlan,
  PLAN_VERSION,
  purchasedPlanName,
  purchasedLimits,
} from '../subscriptions/subscription-policy.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { SubscriptionCatalogService } from '../subscriptions/subscription-catalog.service.js';
import { AiUsageService } from '../subscriptions/ai-usage.service.js';
import {
  PaymentChanged,
  PaymentEventsService,
} from './payment-events.service.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Intent = Omit<PaymentIntent, '_id'>;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  constructor(
    private readonly mongo: MongoService,
    @InjectModel(PaymentIntent.name)
    private readonly intents: Model<PaymentIntent>,
    @InjectModel(PaymentRequest.name)
    private readonly requests: Model<PaymentRequest>,
    @InjectModel(PaymentWebhookReceipt.name)
    private readonly receipts: Model<PaymentWebhookReceipt>,
    @InjectModel(User.name)
    private readonly users: Model<User>,
    private readonly config: ConfigService,
    private readonly provider: SePayProvider,
    private readonly events: PaymentEventsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly usage: AiUsageService,
    private readonly planCatalog: SubscriptionCatalogService,
  ) {}

  async catalog(): Promise<BillingCatalogDto> {
    const { planVersion, freeLimits, paymentsEnabled, plans } =
      await this.planCatalog.current();
    return { planVersion, freeLimits, paymentsEnabled, plans };
  }

  private async lock(
    session: ClientSession,
    kind: 'payer' | 'transaction',
    id: string,
  ) {
    await lockDocument(this.mongo, session, kind, id);
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
      planCode: effectivePlan(intent),
      planVersion: intent.planVersion ?? 1,
      purchasedPlanName: purchasedPlanName(intent),
      textLimit: purchasedLimits(intent).text,
      imageLimit: purchasedLimits(intent).images,
      durationDays: intent.durationDays,
      amount: intent.amount.toString(),
      currency: intent.currency,
      status: intent.status,
      invoiceNumber: intent.invoiceNumber,
      paymentCode: intent.paymentCode,
      createdAt: intent.createdAt.toISOString(),
      expiresAt: paymentExpiresAt(intent).toISOString(),
      serverTime: new Date().toISOString(),
      cancellationReason: intent.cancellationReason ?? null,
      paidAt: intent.paidAt?.toISOString() ?? null,
      capturedAt: intent.capturedAt?.toISOString() ?? null,
      cancelledAt: intent.cancelledAt?.toISOString() ?? null,
      qr:
        intent.status === PaymentStatus.PENDING &&
        paymentExpiresAt(intent).getTime() > Date.now() &&
        this.config.get<boolean>('SEPAY_PAYMENT_ENABLED', false)
          ? this.provider.qr(intent, intent.amount.toString())
          : null,
    };
  }

  async overview(userId: string): Promise<BillingOverviewDto> {
    await this.expirePending(userId);
    const now = new Date();
    const [period, pending, recent] = await Promise.all([
      this.subscriptions.period(userId, now),
      this.intents.findOne({ activeIntentKey: userId }).exec(),
      this.intents
        .find({ userId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(runtimeConfig.BILLING_RECENT_PAYMENTS_LIMIT)
        .exec(),
    ]);
    const [text, images] = await Promise.all([
      this.usage.summaryForPeriod(
        userId,
        AiFeature.MEAL_PLAN_CHAT,
        period,
        now,
      ),
      this.usage.summaryForPeriod(userId, AiFeature.BLOG_IMAGE, period, now),
    ]);
    return {
      usage: { text, images },
      membership:
        period.planCode !== 'FREE'
          ? {
              planCode: period.planCode,
              startsAt: period.startsAt.toISOString(),
              expiresAt: period.expiresAt.toISOString(),
            }
          : { planCode: 'FREE', startsAt: null, expiresAt: null },
      pendingPayment: pending ? this.serialize(pending) : null,
      recentPayments: recent.map((intent) => this.serialize(intent)),
    };
  }

  async get(id: string, userId: string): Promise<PaymentDto> {
    await this.expirePending(userId);
    const intent = await this.intents.findOne({ _id: id, userId }).exec();
    if (!intent)
      throw new ResourceNotFoundException('NOT_FOUND', 'Payment not found');
    return this.serialize(intent);
  }

  async create(
    userId: string,
    planCode: BillingPlan,
    key?: string,
  ): Promise<PaymentDto> {
    this.provider.assertEnabled();
    if (!key || !/^[A-Za-z0-9._:-]{8,200}$/.test(key))
      throw new InvalidInputException(
        'BAD_REQUEST',
        'A valid Idempotency-Key is required',
      );
    const payloadHash = hash({ planCode, planVersion: PLAN_VERSION });
    const attemptCreate = () =>
      this.mongo.withTransaction(async (session) => {
        await this.lock(session, 'payer', userId);
        const pending = await this.intents
          .findOne({ activeIntentKey: userId })
          .session(session)
          .exec();
        const expired =
          pending && (await this.cancelExpired(pending, session, new Date()))
            ? { userId, intentId: pending.id }
            : undefined;
        const prior = await this.requests
          .findOne({ actorId: userId, requestKey: key })
          .session(session)
          .exec();
        if (prior) {
          if (prior.payloadHash !== payloadHash)
            throw new StateConflictException(
              'IDEMPOTENCY_CONFLICT',
              'This key was used with another request',
            );
          const priorIntent = await this.intents
            .findOne({ _id: prior.intentId })
            .session(session)
            .exec();
          if (!priorIntent)
            throw new ResourceNotFoundException(
              'NOT_FOUND',
              'Payment not found',
            );
          return { intent: priorIntent, expired };
        }
        const user = await this.users
          .findOne({ _id: userId })
          .session(session)
          .exec();
        if (
          !user ||
          user.status !== AccountStatus.ACTIVE ||
          !user.emailVerifiedAt
        )
          throw new StateConflictException(
            'ACCOUNT_NOT_PAYABLE',
            'A verified active account is required',
          );
        const catalog = await this.planCatalog.current(session);
        const plan = catalog.plans.find((item) => item.code === planCode);
        if (!plan)
          throw new InvalidInputException(
            'BAD_REQUEST',
            'Unknown billing plan',
          );
        let intent: Intent | null = await this.intents
          .findOne({ activeIntentKey: userId })
          .session(session)
          .exec();
        if (
          intent &&
          (effectivePlan(intent) !== planCode ||
            intent.amount.toString() !== plan.priceVnd ||
            intent.durationDays !== plan.durationDays ||
            purchasedLimits(intent).text !== plan.textLimit ||
            purchasedLimits(intent).images !== plan.imageLimit)
        )
          throw new StateConflictException(
            'PENDING_PAYMENT_CONFLICT',
            'Continue or cancel the pending payment before creating a different purchase',
          );
        if (!intent) {
          const createdAt = new Date();
          const paymentCode = generatePaymentCode(
            this.config.get<string>('SEPAY_PAYMENT_CODE_PREFIX', 'VED'),
          );
          const [created] = await this.intents.create(
            [
              {
                _id: randomUUID(),
                userId,
                planCode,
                planVersion: PLAN_VERSION,
                textLimit: plan.textLimit,
                imageLimit: plan.imageLimit,
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
                cancellationReason: null,
                createdAt,
                expiresAt: new Date(createdAt.getTime() + PAYMENT_LIFETIME_MS),
              },
            ],
            { session },
          );
          intent = created;
        }
        await this.requests.create(
          [
            {
              _id: randomUUID(),
              actorId: userId,
              requestKey: key,
              payloadHash,
              intentId: intent.id,
            },
          ],
          { session },
        );
        return { intent, expired };
      });
    for (
      let attempt = 0;
      attempt < runtimeConfig.PAYMENT_CODE_ALLOCATION_ATTEMPTS;
      attempt++
    ) {
      try {
        const result = await attemptCreate();
        if (result.expired) await this.notifyCommitted(result.expired);
        return this.serialize(result.intent);
      } catch (error) {
        const codeTaken =
          isUniqueViolation(error) && 'paymentCode' in (error.keyPattern ?? {});
        if (!codeTaken) throw error;
      }
    }
    throw new FeatureUnavailableException(
      'PAYMENT_CODE_UNAVAILABLE',
      'Could not allocate a payment code; retry with the same Idempotency-Key',
    );
  }

  async cancel(id: string, userId: string): Promise<PaymentDto> {
    let changed = false;
    const intent = await this.mongo.withTransaction(async (session) => {
      changed = false;
      await this.lock(session, 'payer', userId);
      const current = await this.intents
        .findOne({ _id: id, userId })
        .session(session)
        .exec();
      if (!current)
        throw new ResourceNotFoundException('NOT_FOUND', 'Payment not found');
      if (await this.cancelExpired(current, session, new Date())) {
        changed = true;
        return current;
      }
      if (current.status === PaymentStatus.CANCELLED) return current;
      if (current.status !== PaymentStatus.PENDING)
        throw new StateConflictException(
          'PAYMENT_NOT_PENDING',
          'A completed payment cannot be cancelled or refunded here',
        );
      const now = new Date();
      const updated = await this.intents
        .findOneAndUpdate(
          { _id: id },
          {
            $set: {
              status: PaymentStatus.CANCELLED,
              activeIntentKey: null,
              cancelledAt: now,
              cancellationReason: 'USER',
            },
          },
          { session, returnDocument: 'after' },
        )
        .exec();
      if (!updated)
        throw new ResourceNotFoundException('NOT_FOUND', 'Payment not found');
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
    await this.mongo.withTransaction(async (session) => {
      changed = undefined;
      await this.lock(session, 'transaction', event.providerTransactionId);
      const record = async (outcome: string, intentId?: string) => {
        await this.receipts.create(
          [
            {
              _id: randomUUID(),
              providerTransactionId: event.providerTransactionId,
              payloadHash,
              outcome,
              intentId: intentId ?? null,
            },
          ],
          { session },
        );
      };
      if (event.transferType !== 'in') return record('NOT_INCOMING');
      const paymentCode = event.code?.trim().toUpperCase();
      if (!paymentCode) return record('PAYMENT_CODE_MISSING');
      const found = await this.intents
        .findOne({ paymentCode })
        .session(session)
        .exec();
      if (!found) return record('PAYMENT_INTENT_NOT_FOUND');
      await this.lock(session, 'payer', found.userId);
      const intent = await this.intents
        .findOne({ _id: found.id })
        .session(session)
        .exec();
      if (!intent) return record('PAYMENT_INTENT_NOT_FOUND');
      if (
        event.gateway.toLowerCase() !== intent.bankGateway.toLowerCase() ||
        (event.accountNumber !== intent.accountNumber &&
          event.subAccount !== intent.accountNumber)
      )
        return record('ACCOUNT_MISMATCH', intent.id);
      if (intent.amount !== BigInt(event.transferAmount))
        return record('AMOUNT_MISMATCH', intent.id);
      const used = await this.intents
        .findOne({ providerTransactionId: event.providerTransactionId })
        .select('_id')
        .session(session)
        .exec();
      if (used)
        return record(
          used.id === intent.id ? 'DUPLICATE' : 'TRANSACTION_ALREADY_USED',
          intent.id,
        );
      if (await this.cancelExpired(intent, session, new Date())) {
        changed = { userId: intent.userId, intentId: intent.id };
      }
      if (intent.status !== PaymentStatus.PENDING)
        return record(
          intent.status === PaymentStatus.SUCCEEDED
            ? 'PAYMENT_INTENT_ALREADY_SUCCEEDED'
            : intent.cancellationReason === 'EXPIRED'
              ? 'PAYMENT_EXPIRED'
              : 'PAYMENT_CANCELLED',
          intent.id,
        );
      const user = await this.users
        .findOne({ _id: intent.userId })
        .session(session)
        .exec();
      if (
        !user ||
        user.status !== AccountStatus.ACTIVE ||
        !user.emailVerifiedAt
      )
        return record('ACCOUNT_UNAVAILABLE', intent.id);
      const capturedAt = new Date();
      if (await this.cancelExpired(intent, session, capturedAt)) {
        changed = { userId: intent.userId, intentId: intent.id };
        return record('PAYMENT_EXPIRED', intent.id);
      }
      const claimed = await this.intents
        .updateOne(
          { _id: intent.id, status: PaymentStatus.PENDING },
          {
            $set: {
              status: PaymentStatus.SUCCEEDED,
              activeIntentKey: null,
              providerTransactionId: event.providerTransactionId,
              providerReference: event.referenceCode,
              paidAt: event.paidAt,
              capturedAt,
            },
          },
          { session },
        )
        .exec();
      if (claimed.modifiedCount !== 1)
        throw new StateConflictException(
          'CAPTURE_CONFLICT',
          'Payment changed; retry callback',
        );
      await record('CAPTURED', intent.id);
      changed = { userId: intent.userId, intentId: intent.id };
    });
    if (changed) await this.notifyCommitted(changed);
  }

  async expirePending(userId?: string): Promise<number> {
    const candidates = await this.intents
      .find({
        ...expiredPaymentFilter(new Date()),
        ...(userId ? { userId } : {}),
      })
      .select('_id userId')
      .limit(runtimeConfig.PAYMENT_EXPIRATION_BATCH_SIZE)
      .exec();
    let count = 0;
    for (const candidate of candidates) {
      const expired = await this.mongo.withTransaction(async (session) => {
        await this.lock(session, 'payer', candidate.userId);
        const intent = await this.intents
          .findById(candidate.id)
          .session(session)
          .exec();
        return intent ? this.cancelExpired(intent, session, new Date()) : false;
      });
      if (expired) {
        count++;
        await this.notifyCommitted({
          userId: candidate.userId,
          intentId: candidate.id,
        });
      }
    }
    return count;
  }

  private async cancelExpired(
    intent: Intent,
    session: ClientSession,
    now: Date,
  ): Promise<boolean> {
    if (
      intent.status !== PaymentStatus.PENDING ||
      paymentExpiresAt(intent).getTime() > now.getTime()
    )
      return false;
    const fields = {
      status: PaymentStatus.CANCELLED,
      activeIntentKey: null,
      cancelledAt: now,
      cancellationReason: 'EXPIRED' as const,
    };
    const result = await this.intents
      .updateOne(
        { _id: intent.id, status: PaymentStatus.PENDING },
        { $set: fields },
        { session },
      )
      .exec();
    if (result.modifiedCount !== 1)
      throw new StateConflictException(
        'CAPTURE_CONFLICT',
        'Payment changed; retry',
      );
    Object.assign(intent, fields);
    return true;
  }
}
