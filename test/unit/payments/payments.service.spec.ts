import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FeatureUnavailableException } from '../../../src/common/exceptions/feature-unavailable.exception.js';
import { InvalidInputException } from '../../../src/common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../../src/common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../../../src/common/exceptions/state-conflict.exception.js';
import {
  AccountStatus,
  AiFeature,
  BillingPlan,
  PaymentIntent,
  PaymentRequest,
  PaymentStatus,
  PaymentWebhookReceipt,
  User,
} from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import * as paymentCodes from '../../../src/payments/payment-code.js';
import { PaymentEventsService } from '../../../src/payments/payment-events.service.js';
import { PaymentsService } from '../../../src/payments/payments.service.js';
import { SePayProvider } from '../../../src/payments/sepay.provider.js';
import { AiUsageService } from '../../../src/subscriptions/ai-usage.service.js';
import { SubscriptionsModule } from '../../../src/subscriptions/subscriptions.module.js';
import { SubscriptionsService } from '../../../src/subscriptions/subscriptions.service.js';
import { createUser, deleteWithCascade } from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

describe('PaymentsService', () => {
  const defaultSettings = {
    PAYMENT_REDIS_URL: '',
    SEPAY_PAYMENT_ENABLED: true,
    SEPAY_PAYMENT_CODE_PREFIX: 'VED',
    SEPAY_BANK_WEBHOOK_API_KEY: 'sepay-unit-test-webhook-secret-key',
    SEPAY_QR_BANK_CODE: 'VCB',
    SEPAY_BANK_GATEWAY: 'Vietcombank',
    SEPAY_QR_ACCOUNT_NUMBER: '0012345678',
    SEPAY_QR_ACCOUNT_HOLDER: 'VEDORA TEST',
    SEPAY_QR_STORE_NAME: 'Vedora',
    SEPAY_QR_TRANSFER_PREFIX: 'VEDORA',
    SUBSCRIPTION_PLUS_PRICE_VND: 49000,
    SUBSCRIPTION_PRO_PRICE_VND: 99000,
    BILLING_DURATION_DAYS: 30,
  };

  let app: INestApplication;
  let db: MongoService;
  let config: ConfigService;
  let service: PaymentsService;
  let events: PaymentEventsService;
  let usage: AiUsageService;
  let txCounter = 5000;

  const intents = () => db.connection.model<PaymentIntent>(PaymentIntent.name);
  const requests = () =>
    db.connection.model<PaymentRequest>(PaymentRequest.name);
  const receipts = () =>
    db.connection.model<PaymentWebhookReceipt>(PaymentWebhookReceipt.name);
  const users = () => db.connection.model<User>(User.name);

  async function makeUser(overrides: Partial<User> = {}) {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    return createUser(db, {
      username: `payu_${suffix}`,
      email: `${suffix}@payments.unit`,
      ...overrides,
    });
  }

  function webhookPayload(
    paymentCode: string | null | undefined,
    amount: number,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id: ++txCounter,
      gateway: 'Vietcombank',
      accountNumber: '0012345678',
      subAccount: null,
      transactionDate: '2026-10-23 10:20:30',
      code: paymentCode,
      transferType: 'in',
      transferAmount: amount,
      referenceCode: `REF-${txCounter}`,
      ...overrides,
    };
  }

  beforeAll(async () => {
    config = new ConfigService({ ...defaultSettings });
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongoModule.forTest(createTestMongoUrl('payments_unit')),
        SubscriptionsModule,
      ],
      providers: [
        PaymentsService,
        SePayProvider,
        PaymentEventsService,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(PaymentsService);
    events = app.get(PaymentEventsService);
    usage = app.get(AiUsageService);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(defaultSettings)) {
      config.set(key, value);
    }
    await Promise.all([
      intents().deleteMany({}),
      requests().deleteMany({}),
      receipts().deleteMany({}),
      users().deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (app) {
      await dropTestDatabase(app);
      await app.close();
    }
  });

  describe('catalog and serialize', () => {
    it('returns configured catalog values and falls back to defaults when unset', () => {
      expect(service.catalog()).toEqual({
        planVersion: 2,
        freeLimits: { textLimit: 5, imageLimit: 0 },
        paymentsEnabled: true,
        plans: [
          {
            code: BillingPlan.PLUS,
            name: 'Plus',
            priceVnd: '49000',
            durationDays: 30,
            textLimit: 300,
            imageLimit: 10,
          },
          {
            code: BillingPlan.PRO,
            name: 'Pro',
            priceVnd: '99000',
            durationDays: 30,
            textLimit: 900,
            imageLimit: 40,
          },
        ],
      });

      const fallbackConfig = {
        get: (_key: string, fallback?: unknown) => fallback,
      } as unknown as ConfigService;
      const defaultService = new PaymentsService(
        db,
        intents(),
        requests(),
        receipts(),
        users(),
        fallbackConfig,
        app.get(SePayProvider),
        app.get(PaymentEventsService),
        app.get(SubscriptionsService),
        app.get(AiUsageService),
      );

      expect(defaultService.catalog()).toMatchObject({
        paymentsEnabled: false,
        plans: [
          { code: BillingPlan.PLUS, priceVnd: '49000', durationDays: 30 },
          { code: BillingPlan.PRO, priceVnd: '99000', durationDays: 30 },
        ],
      });
    });

    it('serializes legacy v1 intents, fallback limits, and hides QR when disabled or non-pending', () => {
      const base = {
        id: 'intent-1',
        userId: 'user-1',
        planCode: BillingPlan.PRO,
        durationDays: 30,
        amount: 49000n,
        currency: 'VND',
        status: PaymentStatus.PENDING,
        invoiceNumber: 'VED-1',
        paymentCode: 'VEDABC123',
        activeIntentKey: 'user-1',
        bankCode: 'VCB',
        bankGateway: 'Vietcombank',
        accountNumber: '0012345678',
        accountHolder: 'VEDORA TEST',
        storeName: 'Vedora',
        transferContent: 'VEDORA VEDABC123',
        providerTransactionId: null,
        providerReference: null,
        paidAt: null,
        capturedAt: null,
        cancelledAt: null,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      };

      const pendingDto = service.serialize(base);
      expect(pendingDto).toMatchObject({
        planCode: BillingPlan.PLUS,
        planVersion: 1,
        purchasedPlanName: 'Pro (gói cũ)',
        textLimit: 300,
        imageLimit: 10,
        paidAt: null,
        capturedAt: null,
        cancelledAt: null,
      });
      expect(pendingDto.qr).not.toBeNull();

      config.set('SEPAY_PAYMENT_ENABLED', false);
      expect(service.serialize(base).qr).toBeNull();

      config.set('SEPAY_PAYMENT_ENABLED', true);
      expect(
        service.serialize({
          ...base,
          planCode: BillingPlan.PREMIUM,
          status: PaymentStatus.SUCCEEDED,
          paidAt: new Date('2026-10-01T01:00:00Z'),
          capturedAt: new Date('2026-10-01T01:00:05Z'),
        }),
      ).toMatchObject({
        planCode: BillingPlan.PRO,
        purchasedPlanName: 'Premium (gói cũ)',
        textLimit: 900,
        imageLimit: 40,
        paidAt: '2026-10-01T01:00:00.000Z',
        capturedAt: '2026-10-01T01:00:05.000Z',
        cancelledAt: null,
        qr: null,
      });
    });
  });

  describe('overview and get', () => {
    it('returns FREE overview with pending/recent payments capped at 20, then active membership after capture', async () => {
      const user = await makeUser();
      const empty = await service.overview(user.id);
      expect(empty.membership).toEqual({
        planCode: 'FREE',
        startsAt: null,
        expiresAt: null,
      });
      expect(empty.pendingPayment).toBeNull();
      expect(empty.recentPayments).toEqual([]);
      expect(empty.usage.text.limit).toBe(5);
      expect(empty.usage.images.limit).toBe(0);

      // Create 21 attempts (20 cancelled + 1 pending) to test limit(20)
      for (let i = 0; i < 20; i++) {
        const created = await service.create(
          user.id,
          BillingPlan.PLUS,
          `key-batch-${i}`,
        );
        await service.cancel(created.id, user.id);
      }
      const pending = await service.create(
        user.id,
        BillingPlan.PRO,
        'key-latest-pending',
      );
      const midOverview = await service.overview(user.id);
      expect(midOverview.pendingPayment?.id).toBe(pending.id);
      expect(midOverview.recentPayments).toHaveLength(20);
      expect(midOverview.recentPayments[0].id).toBe(pending.id);

      await service.bankWebhook(webhookPayload(pending.paymentCode, 99000));
      const ticket = await usage.consume(user.id, AiFeature.MEAL_PLAN_CHAT);
      await usage.complete(ticket!);

      const activeOverview = await service.overview(user.id);
      expect(activeOverview.pendingPayment).toBeNull();
      expect(activeOverview.membership.planCode).toBe(BillingPlan.PRO);
      expect(activeOverview.membership.startsAt).not.toBeNull();
      expect(activeOverview.membership.expiresAt).not.toBeNull();
      expect(activeOverview.usage.text).toMatchObject({
        used: 1,
        limit: 900,
        remaining: 899,
        period: 'CYCLE',
      });
    });

    it('gets owned intent and throws NOT_FOUND for missing or unowned intent', async () => {
      const owner = await makeUser();
      const other = await makeUser();
      const created = await service.create(
        owner.id,
        BillingPlan.PLUS,
        'idem-get-test-1',
      );

      expect((await service.get(created.id, owner.id)).id).toBe(created.id);
      await expect(service.get(created.id, other.id)).rejects.toThrow(
        ResourceNotFoundException,
      );
      await expect(service.get(randomUUID(), owner.id)).rejects.toThrow(
        ResourceNotFoundException,
      );
    });
  });

  describe('create', () => {
    it('validates enabled flag, idempotency key format, account status, and plan code', async () => {
      const user = await makeUser();

      config.set('SEPAY_PAYMENT_ENABLED', false);
      await expect(
        service.create(user.id, BillingPlan.PLUS, 'valid-key-1234'),
      ).rejects.toThrow(FeatureUnavailableException);
      config.set('SEPAY_PAYMENT_ENABLED', true);

      for (const badKey of [
        undefined,
        '',
        'short7',
        'x'.repeat(201),
        'bad key with space',
        'bad!key#chars',
      ]) {
        await expect(
          service.create(user.id, BillingPlan.PLUS, badKey),
        ).rejects.toThrow(InvalidInputException);
      }

      // Boundary valid keys (8 and 200 chars with allowed symbols)
      const pMin = await service.create(user.id, BillingPlan.PLUS, 'a._:-123');
      await service.cancel(pMin.id, user.id);
      const pMax = await service.create(
        user.id,
        BillingPlan.PLUS,
        'z'.repeat(200),
      );
      await service.cancel(pMax.id, user.id);

      await expect(
        service.create(user.id, BillingPlan.PREMIUM, 'valid-key-premium'),
      ).rejects.toMatchObject({ statusCode: 400 });

      const unverified = await makeUser({ emailVerifiedAt: null });
      const suspended = await makeUser({ status: AccountStatus.SUSPENDED });
      for (const actorId of [randomUUID(), unverified.id, suspended.id]) {
        await expect(
          service.create(actorId, BillingPlan.PLUS, `key-actor-${actorId}`),
        ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_PAYABLE' });
      }
    });

    it('handles idempotency replay, key conflict, orphaned request, and pending conflicts', async () => {
      const user = await makeUser();
      const key = 'idem-replay-key-1';
      const first = await service.create(user.id, BillingPlan.PLUS, key);

      // Same key + same plan replays existing intent
      expect((await service.create(user.id, BillingPlan.PLUS, key)).id).toBe(
        first.id,
      );

      // Same key + different plan -> IDEMPOTENCY_CONFLICT
      await expect(
        service.create(user.id, BillingPlan.PRO, key),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

      // Different key + same matching pending snapshot reuses pending intent
      const reused = await service.create(
        user.id,
        BillingPlan.PLUS,
        'idem-reuse-same-plan',
      );
      expect(reused.id).toBe(first.id);

      // Different key + different plan while pending -> PENDING_PAYMENT_CONFLICT
      await expect(
        service.create(user.id, BillingPlan.PRO, 'idem-diff-plan'),
      ).rejects.toMatchObject({ code: 'PENDING_PAYMENT_CONFLICT' });

      // Snapshot mismatch (price / duration / textLimit / imageLimit changed on config or intent)
      config.set('SUBSCRIPTION_PLUS_PRICE_VND', 55000);
      await expect(
        service.create(user.id, BillingPlan.PLUS, 'idem-diff-price'),
      ).rejects.toMatchObject({ code: 'PENDING_PAYMENT_CONFLICT' });
      config.set('SUBSCRIPTION_PLUS_PRICE_VND', 49000);

      config.set('BILLING_DURATION_DAYS', 60);
      await expect(
        service.create(user.id, BillingPlan.PLUS, 'idem-diff-duration'),
      ).rejects.toMatchObject({ code: 'PENDING_PAYMENT_CONFLICT' });
      config.set('BILLING_DURATION_DAYS', 30);

      await intents().updateOne(
        { _id: first.id },
        { $set: { textLimit: 111 } },
      );
      await expect(
        service.create(user.id, BillingPlan.PLUS, 'idem-diff-text-limit'),
      ).rejects.toMatchObject({ code: 'PENDING_PAYMENT_CONFLICT' });

      await intents().updateOne(
        { _id: first.id },
        { $set: { textLimit: 300, imageLimit: 3 } },
      );
      await expect(
        service.create(user.id, BillingPlan.PLUS, 'idem-diff-image-limit'),
      ).rejects.toMatchObject({ code: 'PENDING_PAYMENT_CONFLICT' });

      // Cancel then replay old idempotency key still returns cancelled intent
      await service.cancel(first.id, user.id);
      const replayedAfterCancel = await service.create(
        user.id,
        BillingPlan.PLUS,
        key,
      );
      expect(replayedAfterCancel.id).toBe(first.id);
      expect(replayedAfterCancel.status).toBe(PaymentStatus.CANCELLED);

      // Orphaned request without intent -> NOT_FOUND
      await requests().create({
        _id: randomUUID(),
        actorId: user.id,
        requestKey: 'orphan-request-key',
        payloadHash: (await requests().findOne({ requestKey: key }))!
          .payloadHash,
        intentId: randomUUID(),
      });
      await expect(
        service.create(user.id, BillingPlan.PLUS, 'orphan-request-key'),
      ).rejects.toThrow(ResourceNotFoundException);
    });

    it('retries paymentCode unique collisions up to 5 times and fails on unrelated unique errors', async () => {
      const owner = await makeUser();
      const buyer = await makeUser();
      const existing = await service.create(
        owner.id,
        BillingPlan.PLUS,
        'idem-owner-code',
      );

      const spy = vi.spyOn(paymentCodes, 'generatePaymentCode');
      spy.mockReturnValueOnce(existing.paymentCode);
      const created = await service.create(
        buyer.id,
        BillingPlan.PLUS,
        'idem-buyer-retry',
      );
      expect(spy).toHaveBeenCalledTimes(2);
      expect(created.paymentCode).not.toBe(existing.paymentCode);

      const thirdUser = await makeUser();
      spy.mockReset();
      spy.mockReturnValue(existing.paymentCode);
      await expect(
        service.create(thirdUser.id, BillingPlan.PLUS, 'idem-exhaust-key'),
      ).rejects.toMatchObject({
        statusCode: 503,
        code: 'PAYMENT_CODE_UNAVAILABLE',
      });
      expect(spy).toHaveBeenCalledTimes(5);
      expect(
        await requests().countDocuments({ actorId: thirdUser.id }),
      ).toBe(0);

      // Unrelated unique constraint is not retried
      spy.mockRestore();
      await intents().collection.createIndex(
        { amount: 1 },
        {
          name: 'unit_unique_amount',
          unique: true,
          partialFilterExpression: {
            userId: { $in: [owner.id, thirdUser.id] },
          },
        },
      );
      try {
        await expect(
          service.create(thirdUser.id, BillingPlan.PLUS, 'idem-other-unique'),
        ).rejects.toMatchObject({ code: 11000 });
      } finally {
        await intents().collection.dropIndex('unit_unique_amount');
      }
    });
  });

  describe('cancel', () => {
    it('cancels pending intent idempotently, rejects succeeded/unowned, and swallows publish errors', async () => {
      const user = await makeUser();
      const other = await makeUser();
      const publish = vi
        .spyOn(events, 'publish')
        .mockRejectedValueOnce(new Error('redis down'))
        .mockResolvedValue(undefined);

      const pending = await service.create(
        user.id,
        BillingPlan.PLUS,
        'idem-cancel-1',
      );

      await expect(service.cancel(pending.id, other.id)).rejects.toThrow(
        ResourceNotFoundException,
      );

      // First cancel succeeds even though publish rejects
      const cancelled = await service.cancel(pending.id, user.id);
      expect(cancelled.status).toBe(PaymentStatus.CANCELLED);
      expect(cancelled.cancelledAt).not.toBeNull();
      expect(publish).toHaveBeenCalledTimes(1);

      // Second cancel is idempotent and does not publish again
      const again = await service.cancel(pending.id, user.id);
      expect(again.status).toBe(PaymentStatus.CANCELLED);
      expect(publish).toHaveBeenCalledTimes(1);

      // Succeeded intent cannot be cancelled
      const paid = await service.create(
        user.id,
        BillingPlan.PLUS,
        'idem-cancel-paid',
      );
      await service.bankWebhook(webhookPayload(paid.paymentCode, 49000));
      await expect(service.cancel(paid.id, user.id)).rejects.toMatchObject({
        code: 'PAYMENT_NOT_PENDING',
      });
    });
  });

  describe('bankWebhook', () => {
    it('records all non-capture webhook outcomes without mutating intent', async () => {
      const user = await makeUser();
      const other = await makeUser();
      const pending = await service.create(
        user.id,
        BillingPlan.PLUS,
        'idem-wh-1',
      );
      const secondPending = await service.create(
        other.id,
        BillingPlan.PLUS,
        'idem-wh-2',
      );

      const sendAndCheckOutcome = async (
        payload: Record<string, unknown>,
        expectedOutcome: string,
      ) => {
        await service.bankWebhook(payload);
        const receipt = await receipts()
          .findOne({ providerTransactionId: `BANK-${String(payload.id)}` })
          .sort({ createdAt: -1, _id: -1 })
          .exec();
        expect(receipt?.outcome).toBe(expectedOutcome);
      };

      await sendAndCheckOutcome(
        webhookPayload(pending.paymentCode, 49000, { transferType: 'out' }),
        'NOT_INCOMING',
      );
      await sendAndCheckOutcome(
        webhookPayload(null, 49000),
        'PAYMENT_CODE_MISSING',
      );
      await sendAndCheckOutcome(
        webhookPayload('   ', 49000),
        'PAYMENT_CODE_MISSING',
      );
      await sendAndCheckOutcome(
        webhookPayload('VEDUNKNOWN', 49000),
        'PAYMENT_INTENT_NOT_FOUND',
      );
      await sendAndCheckOutcome(
        webhookPayload(pending.paymentCode, 49000, { gateway: 'OtherBank' }),
        'ACCOUNT_MISMATCH',
      );
      await sendAndCheckOutcome(
        webhookPayload(pending.paymentCode, 49000, {
          accountNumber: '999999',
          subAccount: '888888',
        }),
        'ACCOUNT_MISMATCH',
      );
      await sendAndCheckOutcome(
        webhookPayload(pending.paymentCode, 48999),
        'AMOUNT_MISMATCH',
      );
      await sendAndCheckOutcome(
        webhookPayload(pending.paymentCode, 50000),
        'AMOUNT_MISMATCH',
      );

      // Capture secondPending via subAccount and lowercase gateway
      const usedTxId = ++txCounter;
      await sendAndCheckOutcome(
        webhookPayload(secondPending.paymentCode.toLowerCase(), 49000, {
          id: usedTxId,
          gateway: 'vietcombank',
          accountNumber: 'PARENT',
          subAccount: '0012345678',
        }),
        'CAPTURED',
      );

      // Duplicate on same intent
      await sendAndCheckOutcome(
        webhookPayload(secondPending.paymentCode, 49000, { id: usedTxId }),
        'DUPLICATE',
      );

      // Same providerTransactionId on a different intent
      await sendAndCheckOutcome(
        webhookPayload(pending.paymentCode, 49000, { id: usedTxId }),
        'TRANSACTION_ALREADY_USED',
      );

      // New transaction on an already-succeeded intent
      await sendAndCheckOutcome(
        webhookPayload(secondPending.paymentCode, 49000),
        'PAYMENT_INTENT_ALREADY_SUCCEEDED',
      );

      // Cancelled intent
      await service.cancel(pending.id, user.id);
      await sendAndCheckOutcome(
        webhookPayload(pending.paymentCode, 49000),
        'PAYMENT_CANCELLED',
      );

      // Unavailable account (deleted user)
      const doomed = await makeUser();
      const doomedPayment = await service.create(
        doomed.id,
        BillingPlan.PLUS,
        'idem-wh-doomed',
      );
      await deleteWithCascade(db, 'users', doomed.id);
      await sendAndCheckOutcome(
        webhookPayload(doomedPayment.paymentCode, 49000),
        'ACCOUNT_UNAVAILABLE',
      );
    });

    it('rejects malformed payload and throws CAPTURE_CONFLICT if CAS fails', async () => {
      await expect(service.bankWebhook({ bad: true })).rejects.toThrow(
        InvalidInputException,
      );

      const user = await makeUser();
      const pending = await service.create(
        user.id,
        BillingPlan.PLUS,
        'idem-wh-cas',
      );
      const intentModel = db.connection.model<PaymentIntent>(PaymentIntent.name);
      vi.spyOn(intentModel, 'updateOne').mockReturnValueOnce({
        exec: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      } as never);

      await expect(
        service.bankWebhook(webhookPayload(pending.paymentCode, 49000)),
      ).rejects.toThrow(StateConflictException);
    });
  });
});
