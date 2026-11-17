import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppExceptionFilter } from '../../src/common/exceptions/app-exception.filter.js';
import { configureApp } from '../../src/app.setup.js';
import { MongoModule } from '../../src/mongo/mongo.module.js';
import { MongoService } from '../../src/mongo/mongo.service.js';
import {
  AccountStatus,
  BillingPlan,
  PaymentIntent,
  PaymentRequest,
  PaymentStatus,
  PaymentWebhookReceipt,
  User,
} from '../../src/mongo/models.js';
import {
  PaymentReconciliationController,
  PaymentsController,
  SePayWebhookController,
} from '../../src/payments/payments.controller.js';
import { PaymentStreamController } from '../../src/payments/payment-stream.controller.js';
import { PaymentEventsService } from '../../src/payments/payment-events.service.js';
import { PaymentsService } from '../../src/payments/payments.service.js';
import { SePayProvider } from '../../src/payments/sepay.provider.js';
import { SePayWebhookGuard } from '../../src/payments/sepay-webhook.guard.js';
import type {
  BillingOverviewDto,
  PaymentDto,
} from '../../src/payments/payment.dto.js';
import { SubscriptionsModule } from '../../src/subscriptions/subscriptions.module.js';
import { createUser } from '../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../support/mongo-test-db.js';

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
}

interface TestUser {
  id: string;
  token: string;
}

const DAY_MS = 86_400_000;

describe('SePay payment flows (contract matrix)', () => {
  const secret = 'sepay-flows-webhook-secret';
  const settings = {
    PAYMENT_REDIS_URL: '',
    API_PREFIX: 'api/v1',
    SEPAY_PAYMENT_ENABLED: true,
    SEPAY_PAYMENT_CODE_PREFIX: 'VED',
    SEPAY_BANK_WEBHOOK_API_KEY: secret,
    SEPAY_QR_BANK_CODE: 'VCB',
    SEPAY_BANK_GATEWAY: 'Vietcombank',
    SEPAY_QR_ACCOUNT_NUMBER: '0012345678',
    SEPAY_QR_ACCOUNT_HOLDER: 'VEDORA TEST',
    SUBSCRIPTION_PLUS_PRICE_VND: 49000,
    SUBSCRIPTION_PRO_PRICE_VND: 99000,
    BILLING_DURATION_DAYS: 30,
  };
  const path = '/api/v1';
  const webhookPath = `${path}/payments/sepay/bank-transfer-webhook`;
  let app: INestApplication<App>;
  let db: MongoService;
  let service: PaymentsService;
  let jwt: JwtService;
  let config: ConfigService;
  let transactionCounter = 500_000;

  const intents = () => db.connection.model<PaymentIntent>(PaymentIntent.name);
  const requests = () =>
    db.connection.model<PaymentRequest>(PaymentRequest.name);
  const receipts = () =>
    db.connection.model<PaymentWebhookReceipt>(PaymentWebhookReceipt.name);
  const users = () => db.connection.model<User>(User.name);
  const http = () => request(app.getHttpServer());

  async function makeUser(extra: Partial<User> = {}): Promise<TestUser> {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 15);
    const user = await createUser(db, {
      username: `flow${suffix}`,
      email: `${suffix}@payment-flows.test`,
      fullName: 'Payment Flow',
      ...extra,
    });
    return {
      id: user.id,
      token: await jwt.signAsync({ sub: user.id, username: user.username }),
    };
  }

  function createIntent(
    user: TestUser,
    planCode: 'PLUS' | 'PRO' = 'PLUS',
    key: string = randomUUID(),
  ) {
    return http()
      .post(`${path}/billing/payment-intents`)
      .auth(user.token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ planCode, planVersion: 2 });
  }

  async function purchase(
    user: TestUser,
    planCode: 'PLUS' | 'PRO' = 'PLUS',
  ): Promise<PaymentDto> {
    const response = await createIntent(user, planCode).expect(200);
    return response.body as PaymentDto;
  }

  function bankEvent(
    payment: PaymentDto,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    transactionCounter += 1;
    return {
      id: transactionCounter,
      gateway: 'Vietcombank',
      accountNumber: '0012345678',
      subAccount: null,
      transactionDate: '2026-11-17 09:00:00',
      code: payment.paymentCode,
      transferType: 'in',
      transferAmount: Number(payment.amount),
      referenceCode: `FLOW-${transactionCounter}`,
      content: 'Sender private content',
      ...overrides,
    };
  }

  function deliver(body: object, credential = `Apikey ${secret}`) {
    return http().post(webhookPath).set('Authorization', credential).send(body);
  }

  async function outcomeOf(body: Record<string, unknown>): Promise<string[]> {
    const rows = await receipts()
      .find({ providerTransactionId: `BANK-${String(body.id)}` })
      .sort({ createdAt: 1, _id: 1 })
      .exec();
    return rows.map((row) => row.outcome);
  }

  async function statusOf(paymentId: string): Promise<PaymentStatus> {
    const stored = await intents().findById(paymentId).exec();
    if (!stored) throw new Error(`Missing intent ${paymentId}`);
    return stored.status;
  }

  async function billing(user: TestUser): Promise<BillingOverviewDto> {
    const response = await http()
      .get(`${path}/billing/me`)
      .auth(user.token, { type: 'bearer' })
      .expect(200);
    return response.body as BillingOverviewDto;
  }

  async function withConfig<T>(
    key: string,
    value: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous: unknown = config.get(key);
    config.set(key, value);
    try {
      return await run();
    } finally {
      config.set(key, previous);
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongoModule.forTest(createTestMongoUrl('payment_flows')),
        JwtModule.register({ secret: 'sepay-flows-jwt-secret' }),
        SubscriptionsModule,
      ],
      controllers: [
        PaymentStreamController,
        PaymentsController,
        SePayWebhookController,
        PaymentReconciliationController,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AppExceptionFilter },
        PaymentsService,
        SePayProvider,
        SePayWebhookGuard,
        PaymentEventsService,
        { provide: ConfigService, useValue: new ConfigService(settings) },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    db = app.get(MongoService);
    await prepareTestDatabase(app);
    service = app.get(PaymentsService);
    jwt = app.get(JwtService);
    config = app.get(ConfigService);
  });

  afterAll(async () => {
    if (app) {
      await dropTestDatabase(app);
      await app.close();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('creating a payment intent', () => {
    it('rejects an Idempotency-Key one character shorter than the 8-character minimum', async () => {
      const user = await makeUser();

      const response = await createIntent(user, 'PLUS', 'a'.repeat(7));

      expect(response.status).toBe(400);
      expect(await intents().countDocuments({ userId: user.id })).toBe(0);
    });

    it('accepts an Idempotency-Key of exactly 8 characters', async () => {
      const user = await makeUser();

      const response = await createIntent(user, 'PLUS', 'k'.repeat(8));

      expect(response.status).toBe(200);
    });

    it('accepts an Idempotency-Key of exactly 200 characters', async () => {
      const user = await makeUser();

      const response = await createIntent(user, 'PLUS', 'k'.repeat(200));

      expect(response.status).toBe(200);
    });

    it('rejects an Idempotency-Key of 201 characters', async () => {
      const user = await makeUser();

      const response = await createIntent(user, 'PLUS', 'k'.repeat(201));

      expect(response.status).toBe(400);
      expect(await intents().countDocuments({ userId: user.id })).toBe(0);
    });

    it.each(['has space key', 'slash/key/value', 'unicode-khóa-key'])(
      'rejects an Idempotency-Key with unsupported characters: %s',
      async (key) => {
        const user = await makeUser();

        const response = await createIntent(user, 'PLUS', key);

        expect(response.status).toBe(400);
      },
    );

    it('scopes Idempotency-Key per account so two users with the same key get different intents', async () => {
      const one = await makeUser(),
        two = await makeUser(),
        key = randomUUID();

      const first = (await createIntent(one, 'PLUS', key).expect(200))
        .body as PaymentDto;
      const second = (await createIntent(two, 'PLUS', key).expect(200))
        .body as PaymentDto;

      expect(second.id).not.toBe(first.id);
      expect(second.paymentCode).not.toBe(first.paymentCode);
    });

    it('reports an unknown plan as VALIDATION_FAILED per the error contract', async () => {
      const user = await makeUser();

      const response = await http()
        .post(`${path}/billing/payment-intents`)
        .auth(user.token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ planCode: 'VIP', planVersion: 2 });

      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).code).toBe('VALIDATION_FAILED');
    });

    it('rejects an ACTIVE account without a verified email with 409 ACCOUNT_NOT_PAYABLE', async () => {
      const user = await makeUser({ emailVerifiedAt: null });

      const response = await createIntent(user);

      expect(response.status).toBe(409);
      expect((response.body as ErrorBody).code).toBe('ACCOUNT_NOT_PAYABLE');
      expect(await intents().countDocuments({ userId: user.id })).toBe(0);
    });

    it('rejects a suspended account before touching payment state', async () => {
      const user = await makeUser({ status: AccountStatus.SUSPENDED });

      const response = await createIntent(user);

      expect(response.status).toBe(401);
      expect((response.body as ErrorBody).code).toBe('ACCOUNT_SUSPENDED');
      expect(await intents().countDocuments({ userId: user.id })).toBe(0);
    });

    it('returns 503 PAYMENTS_DISABLED and writes nothing while payments are disabled', async () => {
      const user = await makeUser();

      const response = await withConfig('SEPAY_PAYMENT_ENABLED', false, () =>
        createIntent(user),
      );

      expect(response.status).toBe(503);
      expect((response.body as ErrorBody).code).toBe('PAYMENTS_DISABLED');
      expect(await intents().countDocuments({ userId: user.id })).toBe(0);
      expect(await requests().countDocuments({ actorId: user.id })).toBe(0);
    });

    it('returns PENDING_PAYMENT_CONFLICT over HTTP for a different plan while one is pending', async () => {
      const user = await makeUser();
      await purchase(user, 'PLUS');

      const response = await createIntent(user, 'PRO');

      expect(response.status).toBe(409);
      expect((response.body as ErrorBody).code).toBe(
        'PENDING_PAYMENT_CONFLICT',
      );
      expect(await intents().countDocuments({ userId: user.id })).toBe(1);
    });

    it('lets exactly one of two concurrent PLUS/PRO submissions win and rejects the other', async () => {
      const user = await makeUser();

      const responses = await Promise.all([
        createIntent(user, 'PLUS'),
        createIntent(user, 'PRO'),
      ]);

      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 409]);
      expect(await intents().countDocuments({ userId: user.id })).toBe(1);
    });

    it('replays a key used before capture as the current SUCCEEDED intent without a new purchase', async () => {
      const user = await makeUser(),
        key = randomUUID();
      const payment = (await createIntent(user, 'PLUS', key).expect(200))
        .body as PaymentDto;
      await deliver(bankEvent(payment)).expect(200);

      const replay = (await createIntent(user, 'PLUS', key).expect(200))
        .body as PaymentDto;

      expect(replay.id).toBe(payment.id);
      expect(replay.status).toBe('SUCCEEDED');
      expect(replay.qr).toBeNull();
      expect(await intents().countDocuments({ userId: user.id })).toBe(1);
    });

    it('creates a fresh pending intent for a renewal after capture instead of reusing the paid one', async () => {
      const user = await makeUser();
      const paid = await purchase(user);
      await deliver(bankEvent(paid)).expect(200);

      const renewal = await purchase(user);

      expect(renewal.id).not.toBe(paid.id);
      expect(renewal.status).toBe('PENDING');
      expect(renewal.paymentCode).not.toBe(paid.paymentCode);
    });
  });

  describe('reading payments and billing overview', () => {
    it('rejects a non-UUID payment id with 400', async () => {
      const user = await makeUser();

      await http()
        .get(`${path}/payment-intents/not-a-uuid`)
        .auth(user.token, { type: 'bearer' })
        .expect(400);
    });

    it('shows FREE with null dates and a daily allowance resetting at next Bangkok midnight', async () => {
      const user = await makeUser();

      const overview = await billing(user);

      expect(overview.membership).toEqual({
        planCode: 'FREE',
        startsAt: null,
        expiresAt: null,
      });
      expect(overview.pendingPayment).toBeNull();
      expect(overview.usage.text).toMatchObject({
        used: 0,
        limit: 5,
        remaining: 5,
        period: 'DAY',
      });
      expect(overview.usage.images).toMatchObject({ limit: 0, remaining: 0 });
      const resetsAt = new Date(overview.usage.text.resetsAt);
      const bangkokClock = new Date(resetsAt.getTime() + 7 * 3_600_000);
      expect(bangkokClock.toISOString().slice(11)).toBe('00:00:00.000Z');
      expect(resetsAt.getTime() - Date.now()).toBeGreaterThan(0);
      expect(resetsAt.getTime() - Date.now()).toBeLessThanOrEqual(DAY_MS);
    });

    it('caps recentPayments at the 20 newest attempts, newest first', async () => {
      const user = await makeUser();
      const created: string[] = [];
      for (let attempt = 0; attempt < 21; attempt++) {
        const payment = await purchase(user);
        created.push(payment.id);
        await service.cancel(payment.id, user.id);
      }

      const overview = await billing(user);

      const expected = created.slice(1).reverse();
      expect(overview.recentPayments.map((payment) => payment.id)).toEqual(
        expected,
      );
    });

    it('never exposes owner or provider identifiers and only shows QR for PENDING', async () => {
      const user = await makeUser();
      const paid = await purchase(user);
      await deliver(bankEvent(paid)).expect(200);
      const pending = await purchase(user);

      const overview = await billing(user);

      expect(overview.pendingPayment?.id).toBe(pending.id);
      expect(overview.pendingPayment?.qr).not.toBeNull();
      for (const item of overview.recentPayments) {
        expect(item).not.toHaveProperty('userId');
        expect(item).not.toHaveProperty('providerReference');
        expect(item).not.toHaveProperty('providerTransactionId');
        expect(item).not.toHaveProperty('activeIntentKey');
        if (item.status !== PaymentStatus.PENDING) expect(item.qr).toBeNull();
      }
    });

    it('drops the pending payment from billing once it is captured', async () => {
      const user = await makeUser();
      const payment = await purchase(user);
      await deliver(bankEvent(payment)).expect(200);

      const overview = await billing(user);

      expect(overview.pendingPayment).toBeNull();
      expect(overview.membership.planCode).toBe('PLUS');
    });

    it('reports a paid cycle allowance that resets at the membership expiry', async () => {
      const user = await makeUser();
      const payment = await purchase(user, 'PRO');
      await deliver(bankEvent(payment)).expect(200);

      const overview = await billing(user);

      expect(overview.usage.text).toMatchObject({
        limit: 900,
        period: 'CYCLE',
        resetsAt: overview.membership.expiresAt,
      });
      expect(overview.usage.images).toMatchObject({ limit: 40 });
    });

    it('still reads plans and payments but hides the QR while payments are disabled', async () => {
      const user = await makeUser();
      const payment = await purchase(user);

      await withConfig('SEPAY_PAYMENT_ENABLED', false, async () => {
        const plans = await http()
          .get(`${path}/billing/plans`)
          .auth(user.token, { type: 'bearer' })
          .expect(200);
        expect(
          (plans.body as { paymentsEnabled: boolean }).paymentsEnabled,
        ).toBe(false);
        const read = await http()
          .get(`${path}/payment-intents/${payment.id}`)
          .auth(user.token, { type: 'bearer' })
          .expect(200);
        expect((read.body as PaymentDto).qr).toBeNull();
      });
    });
  });

  describe('cancelling', () => {
    it('refuses to cancel a SUCCEEDED payment with 409 PAYMENT_NOT_PENDING and keeps membership', async () => {
      const user = await makeUser();
      const payment = await purchase(user);
      await deliver(bankEvent(payment)).expect(200);

      const response = await http()
        .post(`${path}/payment-intents/${payment.id}/cancel`)
        .auth(user.token, { type: 'bearer' });

      expect(response.status).toBe(409);
      expect((response.body as ErrorBody).code).toBe('PAYMENT_NOT_PENDING');
      expect(await statusOf(payment.id)).toBe('SUCCEEDED');
      expect((await billing(user)).membership.planCode).toBe('PLUS');
    });

    it('returns an identical body, including cancelledAt, when cancelling twice', async () => {
      const user = await makeUser();
      const payment = await purchase(user);
      const cancel = () =>
        http()
          .post(`${path}/payment-intents/${payment.id}/cancel`)
          .auth(user.token, { type: 'bearer' })
          .expect(200);

      const first = (await cancel()).body as PaymentDto;
      const second = (await cancel()).body as PaymentDto;

      expect(first.status).toBe('CANCELLED');
      expect(first.cancelledAt).not.toBeNull();
      expect(second).toEqual(first);
    });

    it('returns 404 NOT_FOUND for an unknown payment id', async () => {
      const user = await makeUser();

      const response = await http()
        .post(`${path}/payment-intents/${randomUUID()}/cancel`)
        .auth(user.token, { type: 'bearer' });

      expect(response.status).toBe(404);
      expect((response.body as ErrorBody).code).toBe('NOT_FOUND');
    });

    it('frees the single pending slot so another plan can be bought after cancellation', async () => {
      const user = await makeUser();
      const plus = await purchase(user, 'PLUS');
      await service.cancel(plus.id, user.id);

      const pro = await purchase(user, 'PRO');

      expect(pro.planCode).toBe('PRO');
      expect((await billing(user)).pendingPayment?.id).toBe(pro.id);
    });
  });

  describe('bank webhook matching', () => {
    it.each([
      ['PLUS', 48999],
      ['PLUS', 49001],
      ['PRO', 98999],
      ['PRO', 99001],
    ] as const)(
      'records AMOUNT_MISMATCH for %s paid %i VND (one off the price)',
      async (plan, amount) => {
        const user = await makeUser();
        const payment = await purchase(user, plan);
        const body = bankEvent(payment, { transferAmount: amount });

        await deliver(body).expect(200, { success: true });

        expect(await outcomeOf(body)).toEqual(['AMOUNT_MISMATCH']);
        expect(await statusOf(payment.id)).toBe('PENDING');
      },
    );

    it('records AMOUNT_MISMATCH when the transfer matches the new catalogue price instead of the snapshot', async () => {
      const user = await makeUser();
      const payment = await purchase(user);

      await withConfig('SUBSCRIPTION_PLUS_PRICE_VND', 59000, async () => {
        const body = bankEvent(payment, { transferAmount: 59000 });
        await deliver(body).expect(200);
        expect(await outcomeOf(body)).toEqual(['AMOUNT_MISMATCH']);
      });
      expect(await statusOf(payment.id)).toBe('PENDING');
    });

    it('captures a provider code given in lowercase with surrounding whitespace', async () => {
      const user = await makeUser();
      const payment = await purchase(user);
      const body = bankEvent(payment, {
        code: `  ${payment.paymentCode.toLowerCase()}  `,
      });

      await deliver(body).expect(200);

      expect(await outcomeOf(body)).toEqual(['CAPTURED']);
      expect(await statusOf(payment.id)).toBe('SUCCEEDED');
    });

    it('does not truncate a longer code that merely starts with the payment code', async () => {
      const user = await makeUser();
      const payment = await purchase(user);
      const body = bankEvent(payment, { code: `${payment.paymentCode}9` });

      await deliver(body).expect(200);

      expect(await outcomeOf(body)).toEqual(['PAYMENT_INTENT_NOT_FOUND']);
      expect(await statusOf(payment.id)).toBe('PENDING');
    });

    it('does not match the random suffix alone without the prefix', async () => {
      const user = await makeUser();
      const payment = await purchase(user);
      const body = bankEvent(payment, { code: payment.paymentCode.slice(3) });

      await deliver(body).expect(200);

      expect(await outcomeOf(body)).toEqual(['PAYMENT_INTENT_NOT_FOUND']);
    });

    it('still captures a pending code issued under a previous prefix after the prefix changes', async () => {
      const user = await makeUser();
      const payment = await purchase(user);

      await withConfig('SEPAY_PAYMENT_CODE_PREFIX', 'PAY', async () => {
        const body = bankEvent(payment);
        await deliver(body).expect(200);
        expect(await outcomeOf(body)).toEqual(['CAPTURED']);
      });
    });

    it.each([
      ['suspended', { status: AccountStatus.SUSPENDED }],
      ['email-unverified', { emailVerifiedAt: null }],
    ] as const)(
      'records ACCOUNT_UNAVAILABLE and keeps PENDING when the payer is %s at callback time',
      async (_label, change) => {
        const user = await makeUser();
        const payment = await purchase(user);
        await users().updateOne({ _id: user.id }, { $set: change });
        const body = bankEvent(payment);

        await deliver(body).expect(200);

        expect(await outcomeOf(body)).toEqual(['ACCOUNT_UNAVAILABLE']);
        expect(await statusOf(payment.id)).toBe('PENDING');
      },
    );

    it('answers 503 and writes no receipt while payments are disabled so SePay retries later', async () => {
      const user = await makeUser();
      const payment = await purchase(user);
      const body = bankEvent(payment);

      const response = await withConfig('SEPAY_PAYMENT_ENABLED', false, () =>
        deliver(body),
      );

      expect(response.status).toBe(503);
      expect(await outcomeOf(body)).toEqual([]);
      expect(await statusOf(payment.id)).toBe('PENDING');
    });

    it('rejects a callback with no Authorization header with 401 UNAUTHORIZED', async () => {
      const user = await makeUser();
      const payment = await purchase(user);
      const body = bankEvent(payment);

      const response = await http().post(webhookPath).send(body);

      expect(response.status).toBe(401);
      expect((response.body as ErrorBody).code).toBe('UNAUTHORIZED');
      expect(await outcomeOf(body)).toEqual([]);
    });

    it('treats a numeric id and the same id as a string as one provider transaction', async () => {
      const user = await makeUser();
      const payment = await purchase(user);
      const numeric = bankEvent(payment);
      const textual = { ...numeric, id: String(numeric.id) };

      await deliver(numeric).expect(200);
      await deliver(textual).expect(200);

      expect(await outcomeOf(numeric)).toEqual(['CAPTURED', 'DUPLICATE']);
    });

    it('captures once when two different transfers for the same intent race', async () => {
      const user = await makeUser();
      const payment = await purchase(user);
      const publish = vi
        .spyOn(app.get(PaymentEventsService), 'publish')
        .mockResolvedValue();
      const first = bankEvent(payment);
      const second = bankEvent(payment);

      await Promise.all([deliver(first), deliver(second)]);

      const outcomes = [
        ...(await outcomeOf(first)),
        ...(await outcomeOf(second)),
      ].sort();
      expect(outcomes).toEqual([
        'CAPTURED',
        'PAYMENT_INTENT_ALREADY_SUCCEEDED',
      ]);
      expect(publish).toHaveBeenCalledOnce();
    });

    it('acknowledges a replay of a captured transfer as DUPLICATE even after the payer is suspended', async () => {
      const user = await makeUser();
      const payment = await purchase(user);
      const body = bankEvent(payment);
      await deliver(body).expect(200);
      await users().updateOne(
        { _id: user.id },
        { $set: { status: AccountStatus.SUSPENDED } },
      );
      const publish = vi
        .spyOn(app.get(PaymentEventsService), 'publish')
        .mockResolvedValue();

      await deliver(body).expect(200);

      expect(await outcomeOf(body)).toEqual(['CAPTURED', 'DUPLICATE']);
      expect(await statusOf(payment.id)).toBe('SUCCEEDED');
      expect(publish).not.toHaveBeenCalled();
    });

    it('replaces an active Pro cycle with Plus immediately on downgrade, without keeping the higher tier', async () => {
      const user = await makeUser();
      const pro = await purchase(user, 'PRO');
      await deliver(bankEvent(pro)).expect(200);
      const plus = await purchase(user, 'PLUS');

      await deliver(bankEvent(plus)).expect(200);

      const overview = await billing(user);
      const stored = await intents().findById(plus.id).exec();
      expect(overview.membership.planCode).toBe('PLUS');
      expect(overview.membership.startsAt).toBe(
        stored?.capturedAt?.toISOString(),
      );
      expect(overview.usage.text.limit).toBe(300);
    });
  });

  describe('payment event stream access', () => {
    it('rejects a token passed in the query string instead of the Authorization header', async () => {
      const user = await makeUser();
      const payment = await purchase(user);

      await http()
        .get(
          `${path}/payment-intents/${payment.id}/events?access_token=${user.token}`,
        )
        .expect(401);
    });

    it('rejects a non-UUID stream id with 400', async () => {
      const user = await makeUser();

      await http()
        .get(`${path}/payment-intents/not-a-uuid/events`)
        .auth(user.token, { type: 'bearer' })
        .expect(400);
    });

    it('rejects a suspended owner before opening the stream', async () => {
      const user = await makeUser();
      const payment = await purchase(user);
      await users().updateOne(
        { _id: user.id },
        { $set: { status: AccountStatus.SUSPENDED } },
      );

      await http()
        .get(`${path}/payment-intents/${payment.id}/events`)
        .auth(user.token, { type: 'bearer' })
        .expect(401);
    });
  });

  describe('no client-side paid mutation', () => {
    it.each([
      ['post', 'capture'],
      ['post', 'confirm'],
      ['post', 'refund'],
      ['patch', ''],
    ] as const)(
      'exposes no %s route to mark a payment paid (%s)',
      async (method, action) => {
        const user = await makeUser();
        const payment = await purchase(user);
        const target = action
          ? `${path}/payment-intents/${payment.id}/${action}`
          : `${path}/payment-intents/${payment.id}`;

        const response = await http()
          [method](target)
          .auth(user.token, { type: 'bearer' })
          .send({ status: 'SUCCEEDED' });

        expect(response.status).toBe(404);
        expect(await statusOf(payment.id)).toBe('PENDING');
      },
    );
  });

  it('refuses a legacy PREMIUM purchase at the service layer, behind the DTO', async () => {
    const user = await makeUser();

    await expect(
      service.create(user.id, BillingPlan.PREMIUM, randomUUID()),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await intents().countDocuments({ userId: user.id })).toBe(0);
  });
});
