import { plainToInstance } from 'class-transformer';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { vi } from 'vitest';
import {
  AccountStatus,
  AiFeature,
  AiRequest,
  BillingPlan,
  PaymentIntent,
  PaymentRequest,
  PaymentStatus,
  PaymentWebhookReceipt,
  SubscriptionCatalog,
  SubscriptionMembership,
  SubscriptionGrant,
  SystemLog,
  User,
  UserRole,
} from '@src/mongo/models.js';
import { SubscriptionCatalogService } from '@src/subscriptions/subscription-catalog.service.js';
import {
  AdminSubscriptionCatalogDto,
  type UpdateSubscriptionCatalogDto,
} from '@src/subscriptions/subscription-catalog.dto.js';
import { SubscriptionsService } from '@src/subscriptions/subscriptions.service.js';
import { AiUsageService } from '@src/subscriptions/ai-usage.service.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createUser } from '@test/support/fixtures.js';
import { PaymentDto } from '@src/payments/payment.dto.js';

const path = '/api/v1/admin/subscription-plans';
const secret = 'subscription-fixture-webhook-secret';
const readCatalog = (response: request.Response): AdminSubscriptionCatalogDto =>
  plainToInstance(
    AdminSubscriptionCatalogDto,
    JSON.parse(response.text) as unknown,
  );
const readPayment = (response: request.Response): PaymentDto =>
  plainToInstance(PaymentDto, JSON.parse(response.text) as unknown);

describe('Admin subscription catalog and purchased QR contracts (real MongoDB HTTP)', () => {
  let e2e: E2eApp;
  let admin: User, member: User;
  let token: string, memberToken: string;
  let transactions = 0;
  const http = () => request(e2e.app.getHttpServer());
  const model = <T>(name: string) => e2e.connection.model<T>(name);
  const get = (jwt = token) => http().get(path).auth(jwt, { type: 'bearer' });
  const put = (body: object, jwt = token) =>
    http().put(path).auth(jwt, { type: 'bearer' }).send(body);
  const draft = (version = 0): UpdateSubscriptionCatalogDto => ({
    version,
    freeLimits: { textLimit: 7, imageLimit: 1 },
    plans: [
      {
        code: BillingPlan.PLUS,
        priceVnd: 59000,
        textLimit: 400,
        imageLimit: 15,
      },
      {
        code: BillingPlan.PRO,
        priceVnd: 119000,
        textLimit: 1200,
        imageLimit: 50,
      },
    ],
  });
  const buy = (key = randomUUID()) =>
    http()
      .post('/api/v1/billing/payment-intents')
      .auth(memberToken, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ planCode: 'PLUS', planVersion: 2 });
  const pay = (payment: PaymentDto, amount: number) =>
    http()
      .post('/api/v1/payments/sepay/bank-transfer-webhook')
      .set('Authorization', `Apikey ${secret}`)
      .send({
        id: ++transactions,
        gateway: 'Vietcombank',
        accountNumber: '0012345678',
        transactionDate: '2026-11-28 00:00:00',
        code: payment.paymentCode,
        transferType: 'in',
        transferAmount: amount,
        referenceCode: `REF-${transactions}`,
      });

  beforeAll(async () => {
    e2e = await createE2eApp('admin_subscription_plans');
    const config = e2e.app.get(ConfigService);
    for (const [key, value] of Object.entries({
      SEPAY_PAYMENT_ENABLED: true,
      SEPAY_BANK_WEBHOOK_API_KEY: secret,
      SEPAY_QR_BANK_CODE: 'VCB',
      SEPAY_BANK_GATEWAY: 'Vietcombank',
      SEPAY_QR_ACCOUNT_NUMBER: '0012345678',
      SEPAY_QR_ACCOUNT_HOLDER: 'FIXTURE',
      SUBSCRIPTION_PLUS_PRICE_VND: 49000,
      SUBSCRIPTION_PRO_PRICE_VND: 99000,
      BILLING_DURATION_DAYS: 30,
    }))
      config.set(key, value);
    admin = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    member = await createUser(e2e.mongo);
    token = await e2e.sign(admin);
    memberToken = await e2e.sign(member);
  });
  beforeEach(async () => {
    await Promise.all([
      model(SubscriptionCatalog.name).deleteMany({}),
      model(SubscriptionMembership.name).deleteMany({}),
      model(SubscriptionGrant.name).deleteMany({}),
      model(PaymentIntent.name).deleteMany({}),
      model(PaymentRequest.name).deleteMany({}),
      model(PaymentWebhookReceipt.name).deleteMany({}),
      model(AiRequest.name).deleteMany({}),
    ]);
  });
  afterAll(async () => {
    if (e2e) await e2e.close();
  });

  it('requires an active ADMIN from the database for reads and writes', async () => {
    await http().get(path).expect(401);
    await http().put(path).send(draft()).expect(401);
    const forged = await e2e.app
      .get(JwtService)
      .signAsync({ sub: member.id, role: 'ADMIN', username: member.username });
    await get(forged).expect(403);
    await put(draft(), forged).expect(403);
    const suspended = await createUser(e2e.mongo, {
      role: UserRole.ADMIN,
      status: AccountStatus.SUSPENDED,
    });
    await get(await e2e.sign(suspended)).expect(401);
    expect(await model(SubscriptionCatalog.name).countDocuments()).toBe(0);
  });

  it('uses exact env defaults without writing settings on GET and keeps admin metadata private', async () => {
    const response = await get().expect(200);
    const { headers } = response;
    const body = readCatalog(response);
    expect(body).toMatchObject({
      version: 0,
      source: 'ENV',
      updatedAt: null,
      updatedById: null,
      freeLimits: { textLimit: 5, imageLimit: 0 },
      plans: [
        {
          code: 'PLUS',
          priceVnd: '49000',
          textLimit: 300,
          imageLimit: 10,
          durationDays: 30,
        },
        {
          code: 'PRO',
          priceVnd: '99000',
          textLimit: 900,
          imageLimit: 40,
          durationDays: 30,
        },
      ],
    });
    expect(headers['cache-control']).toContain('private, no-store');
    expect(headers.vary).toContain('Authorization');
    expect(await model(SubscriptionCatalog.name).countDocuments()).toBe(0);
    const publicCatalog = await http()
      .get('/api/v1/billing/plans')
      .auth(memberToken, { type: 'bearer' })
      .expect(200);
    expect(publicCatalog.body).not.toHaveProperty('updatedById');
    expect(publicCatalog.body).not.toHaveProperty('version');
  });

  it('persists an atomic catalog and reads it from a fresh service instance', async () => {
    const saved = readCatalog(await put(draft()).expect(200));
    expect(saved).toMatchObject({
      version: 1,
      source: 'DATABASE',
      updatedById: admin.id,
    });
    expect(saved.updatedAt).toEqual(expect.any(String));
    expect(saved.plans[0]).toMatchObject({
      priceVnd: '59000',
      textLimit: 400,
      imageLimit: 15,
    });
    const fresh = new SubscriptionCatalogService(
      model<SubscriptionCatalog>(SubscriptionCatalog.name),
      e2e.app.get(ConfigService),
    );
    expect(await fresh.current()).toEqual(saved);
    const catalog = await http()
      .get('/api/v1/billing/plans')
      .auth(memberToken, { type: 'bearer' })
      .expect(200);
    expect(readCatalog(catalog).plans).toEqual(saved.plans);
    expect(readCatalog(catalog).freeLimits).toEqual(saved.freeLimits);
  });

  it.each([
    { version: -1 },
    { version: '0' },
    { version: null },
    { freeLimits: null },
    { freeLimits: { textLimit: -1, imageLimit: 0 } },
    { freeLimits: { textLimit: 2.5, imageLimit: 0 } },
    { freeLimits: { textLimit: 5, imageLimit: 1_000_001 } },
    { freeLimits: { textLimit: 5, imageLimit: 0, extra: true } },
    { plans: [] },
    { plans: [null, null] },
    { plans: [{ code: 'PLUS', priceVnd: 1, textLimit: 0, imageLimit: 0 }] },
    {
      plans: [
        { code: 'PLUS', priceVnd: 1, textLimit: 0, imageLimit: 0 },
        { code: 'PLUS', priceVnd: 2, textLimit: 0, imageLimit: 0 },
      ],
    },
    {
      plans: [
        { code: 'PREMIUM', priceVnd: 1, textLimit: 0, imageLimit: 0 },
        { code: 'PRO', priceVnd: 2, textLimit: 0, imageLimit: 0 },
      ],
    },
    {
      plans: [
        { code: 'PLUS', priceVnd: 0, textLimit: 0, imageLimit: 0 },
        { code: 'PRO', priceVnd: 2, textLimit: 0, imageLimit: 0 },
      ],
    },
    {
      plans: [
        { code: 'PLUS', priceVnd: 1_000_000_001, textLimit: 0, imageLimit: 0 },
        { code: 'PRO', priceVnd: 2, textLimit: 0, imageLimit: 0 },
      ],
    },
    { durationDays: 99 },
  ])(
    'rejects malformed or out-of-range data without partial writes: %j',
    async (invalid) => {
      await put({ ...draft(), ...invalid }).expect(400);
      expect(await model(SubscriptionCatalog.name).countDocuments()).toBe(0);
    },
  );

  it('allows zero quotas and the same or lower price than another plan without inventing hierarchy rules', async () => {
    const input = draft();
    input.plans = input.plans.map((plan) => ({
      ...plan,
      priceVnd: 1,
      textLimit: 0,
      imageLimit: 0,
    }));
    const body = readCatalog(await put(input).expect(200));
    expect(body.plans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ priceVnd: '1', textLimit: 0, imageLimit: 0 }),
      ]),
    );
  });

  it('rejects stale first saves and concurrent revisions instead of silently overwriting', async () => {
    await put(draft()).expect(200);
    await put(draft())
      .expect(409)
      .expect(({ text }) =>
        expect(JSON.parse(text) as unknown).toMatchObject({
          code: 'SUBSCRIPTION_CATALOG_CONFLICT',
        }),
      );
    const second = draft(1),
      third = draft(1);
    third.plans[0] = {
      code: BillingPlan.PLUS,
      priceVnd: 69000,
      textLimit: 500,
      imageLimit: 20,
    };
    const responses = await Promise.all([put(second), put(third)]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const body = readCatalog(await get().expect(200));
    expect(body.version).toBe(2);
    const winner = responses.find(({ status }) => status === 200)!;
    expect(body.plans).toEqual(readCatalog(winner).plans);
    expect(await model(SubscriptionCatalog.name).countDocuments()).toBe(1);
  });

  it('retains a pending QR snapshot and its idempotent replay after an admin changes the catalog', async () => {
    const key = randomUUID();
    const old = readPayment(await buy(key).expect(200));
    await put(draft()).expect(200);
    const pending = readPayment(
      await http()
        .get(`/api/v1/payment-intents/${old.id}`)
        .auth(memberToken, { type: 'bearer' })
        .expect(200),
    );
    expect(pending).toMatchObject({
      id: old.id,
      amount: '49000',
      textLimit: 300,
      imageLimit: 10,
      durationDays: 30,
      expiresAt: old.expiresAt,
    });
    expect(pending.qr!.amount).toBe('49000');
    expect(new URL(pending.qr!.imageUrl).searchParams.get('amount')).toBe(
      '49000',
    );
    const replay = await buy(key).expect(200);
    expect(replay.body).toMatchObject({
      id: old.id,
      amount: '49000',
      textLimit: 300,
    });
    await buy()
      .expect(409)
      .expect(({ text }) =>
        expect(JSON.parse(text) as unknown).toMatchObject({
          code: 'PENDING_PAYMENT_CONFLICT',
        }),
      );
    await http()
      .post(`/api/v1/payment-intents/${old.id}/cancel`)
      .auth(memberToken, { type: 'bearer' })
      .expect(200);
    const fresh = await buy().expect(200);
    expect(fresh.body).toMatchObject({
      amount: '59000',
      textLimit: 400,
      imageLimit: 15,
      durationDays: 30,
    });
    expect(readPayment(fresh).id).not.toBe(old.id);
  });

  it('matches webhook money and grants AI allowances from the old QR, not the changed catalog', async () => {
    const old = readPayment(await buy().expect(200));
    await put(draft()).expect(200);
    await pay(old, 59000).expect(200);
    expect(
      (await model<PaymentIntent>(PaymentIntent.name).findById(old.id))!.status,
    ).toBe(PaymentStatus.PENDING);
    expect(
      await model(PaymentWebhookReceipt.name).exists({
        intentId: old.id,
        outcome: 'AMOUNT_MISMATCH',
      }),
    ).not.toBeNull();
    await pay(old, 49000).expect(200);
    const subscriptions = e2e.app.get(SubscriptionsService);
    const paid = await subscriptions.period(member.id);
    expect(paid).toMatchObject({
      planCode: 'PLUS',
      textLimit: 300,
      imageLimit: 10,
    });
    expect(paid.expiresAt.getTime() - paid.startsAt.getTime()).toBe(
      30 * 86_400_000,
    );
    const newer = draft(1);
    newer.plans[0].textLimit = 1;
    await put(newer).expect(200);
    expect(await subscriptions.period(member.id)).toMatchObject({
      textLimit: 300,
      imageLimit: 10,
      key: paid.key,
      expiresAt: paid.expiresAt,
    });
    expect(await subscriptions.period(member.id, paid.expiresAt)).toMatchObject(
      { planCode: 'FREE', textLimit: 7, imageLimit: 1 },
    );
  });

  it('keeps historical fallback entitlements when old purchases have no quota snapshot', async () => {
    const old = readPayment(await buy().expect(200));
    await model(PaymentIntent.name).updateOne(
      { _id: old.id },
      {
        $set: {
          status: PaymentStatus.SUCCEEDED,
          capturedAt: new Date(),
          planVersion: 1,
          planCode: BillingPlan.PRO,
        },
        $unset: { textLimit: 1, imageLimit: 1 },
      },
    );
    await put(draft()).expect(200);
    expect(
      await e2e.app.get(SubscriptionsService).period(member.id),
    ).toMatchObject({ planCode: 'PLUS', textLimit: 300, imageLimit: 10 });
  });

  it('updates Free quotas immediately without resetting already charged requests', async () => {
    const usage = e2e.app.get(AiUsageService);
    const first = await usage.consume(member.id, AiFeature.MEAL_PLAN_CHAT);
    expect(first).not.toBeNull();
    await usage.complete(first!);
    const before = await usage.summary(member.id, AiFeature.MEAL_PLAN_CHAT);
    const input = draft();
    input.freeLimits = { textLimit: 1, imageLimit: 0 };
    await put(input).expect(200);
    expect(
      await usage.summary(member.id, AiFeature.MEAL_PLAN_CHAT),
    ).toMatchObject({
      used: 1,
      limit: 1,
      remaining: 0,
      resetsAt: before.resetsAt,
    });
    expect(await usage.consume(member.id, AiFeature.MEAL_PLAN_CHAT)).toBeNull();
    input.version = 1;
    input.freeLimits.textLimit = 2;
    await put(input).expect(200);
    expect(
      await usage.summary(member.id, AiFeature.MEAL_PLAN_CHAT),
    ).toMatchObject({ used: 1, limit: 2, remaining: 1 });
  });

  it('records successful and conflicting admin mutations with a distinct system log resource', async () => {
    const startedAt = new Date();
    const saved = readCatalog(await put(draft()).expect(200));
    await put(draft()).expect(409);
    await vi.waitFor(async () => {
      const logs = await model<SystemLog>(SystemLog.name)
        .find({
          resourceType: 'SUBSCRIPTION_PLANS',
          actorId: admin.id,
          createdAt: { $gte: startedAt },
        })
        .lean();
      expect(
        logs.some(
          (log) => log.outcome === 'SUCCESS' && log.targetId === saved.id,
        ),
      ).toBe(true);
      expect(
        logs.some(
          (log) =>
            log.outcome === 'FAILURE' &&
            log.errorCode === 'SUBSCRIPTION_CATALOG_CONFLICT',
        ),
      ).toBe(true);
    });
  });

  it('denies voice session and turn APIs to Free, Plus and an admin without Pro', async () => {
    const sessionPath = '/api/v1/meal-plan/voice/session';
    const turnsPath = '/api/v1/meal-plan/voice/turns';
    const turn = { weekStart: '2026-11-23', message: 'Xin chào' };
    await http()
      .post(sessionPath)
      .auth(memberToken, { type: 'bearer' })
      .send({})
      .expect(403)
      .expect(({ text }) =>
        expect(JSON.parse(text) as unknown).toMatchObject({
          code: 'PRO_REQUIRED',
        }),
      );
    await http()
      .post(turnsPath)
      .auth(memberToken, { type: 'bearer' })
      .send(turn)
      .expect(403);
    // ADMIN has Pro by role on main; check the entitlement without calling
    // the real voice provider to mint a token.
    expect(
      await e2e.app.get(SubscriptionsService).requireProVoice(admin.id),
    ).toMatchObject({ planCode: 'PRO' });
    const plus = readPayment(await buy().expect(200));
    await pay(plus, 49000).expect(200);
    await http()
      .post(sessionPath)
      .auth(memberToken, { type: 'bearer' })
      .send({})
      .expect(403);
    await http()
      .post(turnsPath)
      .auth(memberToken, { type: 'bearer' })
      .send(turn)
      .expect(403);
  });

  it('grants existing Pro voice independently of text quota and isolates request channels', async () => {
    const order = readPayment(
      await http()
        .post('/api/v1/billing/payment-intents')
        .auth(memberToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ planCode: 'PRO', planVersion: 2 })
        .expect(200),
    );
    await pay(order, 99000).expect(200);
    // The Pro purchase exists before the new voice policy reads it; no voice flag or minutes need migrating.
    await model(SubscriptionMembership.name).updateOne(
      { _id: member.id },
      { $set: { textLimit: 0 } },
    );
    const subscriptions = e2e.app.get(SubscriptionsService);
    expect(await subscriptions.requireProVoice(member.id)).toMatchObject({
      planCode: 'PRO',
      textLimit: 0,
    });
    const usage = e2e.app.get(AiUsageService);
    expect(await usage.consume(member.id, AiFeature.MEAL_PLAN_CHAT)).toBeNull();
    const requestId = randomUUID();
    const ticket = await usage.consumeVoice(
      member.id,
      AiFeature.MEAL_PLAN_CHAT,
      { requestId, input: 'voice turn' },
    );
    expect(ticket).not.toBeNull();
    await usage.complete(ticket!);
    expect(
      await model<AiRequest>(AiRequest.name).findById(ticket!.id),
    ).toMatchObject({ bucket: 'VOICE', charged: true });
    expect(
      await usage.summary(member.id, AiFeature.MEAL_PLAN_CHAT),
    ).toMatchObject({ used: 0, limit: 0 });
    await expect(
      usage.consume(member.id, AiFeature.MEAL_PLAN_CHAT, {
        requestId,
        input: 'voice turn',
        continuation: true,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const period = await subscriptions.period(member.id);
    await expect(
      subscriptions.requireProVoice(member.id, period.expiresAt),
    ).rejects.toMatchObject({ code: 'PRO_REQUIRED' });
  });

  it('removes voice access immediately for new planner requests after a downgrade to Plus', async () => {
    const pro = readPayment(
      await http()
        .post('/api/v1/billing/payment-intents')
        .auth(memberToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ planCode: 'PRO', planVersion: 2 })
        .expect(200),
    );
    await pay(pro, 99000).expect(200);
    await e2e.app.get(SubscriptionsService).requireProVoice(member.id);
    const plus = readPayment(await buy().expect(200));
    await pay(plus, 49000).expect(200);
    await expect(
      e2e.app
        .get(AiUsageService)
        .consumeVoice(member.id, AiFeature.MEAL_PLAN_CHAT),
    ).rejects.toMatchObject({ code: 'PRO_REQUIRED' });
    await http()
      .post('/api/v1/meal-plan/voice/turns')
      .auth(memberToken, { type: 'bearer' })
      .send({ weekStart: '2026-11-23', message: 'Tiếp tục' })
      .expect(403);
  });
});
