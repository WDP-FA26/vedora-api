import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { vi } from 'vitest';
import {
  AccountStatus,
  AccountType,
  AiFeature,
  AiRequest,
  BillingPlan,
  PaymentIntent,
  PaymentRequest,
  PaymentWebhookReceipt,
  SubscriptionCatalog,
  SubscriptionGrant,
  SubscriptionMembership,
  SystemLog,
  User,
  UserRole,
} from '@src/mongo/models.js';
import {
  GrantUserDetailDto,
  SubscriptionGrantDto,
  type CreateSubscriptionGrantDto,
} from '@src/subscriptions/subscription-grant.dto.js';
import { SubscriptionsService } from '@src/subscriptions/subscriptions.service.js';
import { AiUsageService } from '@src/subscriptions/ai-usage.service.js';
import { SubscriptionGrantsService } from '@src/subscriptions/subscription-grants.service.js';
import { PaymentDto } from '@src/payments/payment.dto.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createUser } from '@test/support/fixtures.js';

const base = '/api/v1/admin/subscription-plans';
const webhookKey = 'grant-test-webhook-placeholder';
describe('Administrative subscription grants (real MongoDB and HTTP)', () => {
  let e2e: E2eApp,
    admin: User,
    member: User,
    token: string,
    memberToken: string;
  let transaction = 0;
  const http = () => request(e2e.app.getHttpServer());
  const model = <T>(name: string) => e2e.connection.model<T>(name);
  const get = (path: string, jwt = token) =>
    http().get(path).auth(jwt, { type: 'bearer' });
  const grant = (input: object, key: string = randomUUID(), jwt = token) =>
    http()
      .post(`${base}/grants`)
      .auth(jwt, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send(input);
  async function input(
    userId = member.id,
    planCode: BillingPlan.PLUS | BillingPlan.PRO = BillingPlan.PRO,
  ): Promise<CreateSubscriptionGrantDto> {
    const detail = plainToInstance(
      GrantUserDetailDto,
      JSON.parse(
        (await get(`${base}/users/${userId}`).expect(200)).text,
      ) as unknown,
    );
    return {
      userId,
      planCode,
      catalogVersion: 0,
      expectedPeriodKey: detail.membership.key,
      reason: 'Customer support fixture',
    };
  }
  const readGrant = (res: request.Response) =>
    plainToInstance(SubscriptionGrantDto, JSON.parse(res.text) as unknown);
  async function buy(planCode: 'PLUS' | 'PRO' = 'PLUS') {
    const response = await http()
      .post('/api/v1/billing/payment-intents')
      .auth(memberToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ planCode, planVersion: 2 })
      .expect(200);
    return plainToInstance(PaymentDto, JSON.parse(response.text) as unknown);
  }
  function pay(order: PaymentDto, id = ++transaction) {
    return http()
      .post('/api/v1/payments/sepay/bank-transfer-webhook')
      .set('Authorization', `Apikey ${webhookKey}`)
      .send({
        id,
        gateway: 'Vietcombank',
        accountNumber: '0012345678',
        transactionDate: '2026-11-28 00:00:00',
        code: order.paymentCode,
        transferType: 'in',
        transferAmount: Number(order.amount),
        referenceCode: `GRANT-${id}`,
      });
  }
  beforeAll(async () => {
    e2e = await createE2eApp('admin_subscription_grants');
    admin = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    member = await createUser(e2e.mongo);
    token = await e2e.sign(admin);
    memberToken = await e2e.sign(member);
    const config = e2e.app.get(ConfigService);
    for (const [key, value] of Object.entries({
      SEPAY_PAYMENT_ENABLED: true,
      SEPAY_BANK_WEBHOOK_API_KEY: webhookKey,
      SEPAY_QR_BANK_CODE: 'VCB',
      SEPAY_BANK_GATEWAY: 'Vietcombank',
      SEPAY_QR_ACCOUNT_NUMBER: '0012345678',
      SEPAY_QR_ACCOUNT_HOLDER: 'FIXTURE',
      SUBSCRIPTION_PLUS_PRICE_VND: 49000,
      SUBSCRIPTION_PRO_PRICE_VND: 99000,
      BILLING_DURATION_DAYS: 30,
    }))
      config.set(key, value);
  });
  beforeEach(async () => {
    for (const name of [
      SubscriptionGrant.name,
      SubscriptionMembership.name,
      SubscriptionCatalog.name,
      PaymentIntent.name,
      PaymentRequest.name,
      PaymentWebhookReceipt.name,
      AiRequest.name,
    ])
      await model(name).deleteMany({});
  });
  afterAll(async () => {
    if (e2e) await e2e.close();
  });

  it('requires ADMIN for search, detail and grant, including forged role claims', async () => {
    const body = await input();
    await http().get(`${base}/users`).expect(401);
    await http().post(`${base}/grants`).send(body).expect(401);
    await get(`${base}/users`, memberToken).expect(403);
    await get(`${base}/users/${member.id}`, memberToken).expect(403);
    await grant(body, randomUUID(), memberToken).expect(403);
    const forged = await e2e.app
      .get(JwtService)
      .signAsync({ sub: member.id, username: member.username, role: 'ADMIN' });
    await grant(body, randomUUID(), forged).expect(403);
    expect(await model(SubscriptionGrant.name).countDocuments()).toBe(0);
  });

  it('permits suspended and pending-email personal recipients with the cycle starting immediately', async () => {
    for (const status of [
      AccountStatus.SUSPENDED,
      AccountStatus.PENDING_EMAIL,
    ]) {
      const target = await createUser(e2e.mongo, {
        status,
        emailVerifiedAt: null,
      });
      const saved = readGrant(await grant(await input(target.id)).expect(200));
      expect(saved.userId).toBe(target.id);
      expect(
        await e2e.app.get(SubscriptionsService).period(target.id),
      ).toMatchObject({ planCode: 'PRO' });
      await get('/api/v1/billing/me', await e2e.sign(target)).expect(401);
    }
  });

  it('rechecks the administrator inside the grant transaction', async () => {
    const body = await input();
    await model(User.name).updateOne(
      { _id: admin.id },
      { $set: { role: UserRole.USER } },
    );
    try {
      await expect(
        e2e.app
          .get(SubscriptionGrantsService)
          .create(admin.id, body, randomUUID()),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await model(SubscriptionGrant.name).countDocuments()).toBe(0);
    } finally {
      await model(User.name).updateOne(
        { _id: admin.id },
        { $set: { role: UserRole.ADMIN } },
      );
    }
  });

  it('keeps role-based Admin Pro ahead of a Plus grant and reads the grant after role removal', async () => {
    const saved = readGrant(
      await grant(await input(admin.id, BillingPlan.PLUS)).expect(200),
    );
    const subscriptions = e2e.app.get(SubscriptionsService);
    expect(await subscriptions.requireProVoice(admin.id)).toMatchObject({
      planCode: 'PRO',
    });
    await model(User.name).updateOne(
      { _id: admin.id },
      { $set: { role: UserRole.USER } },
    );
    try {
      expect(await subscriptions.period(admin.id)).toMatchObject({
        planCode: 'PLUS',
        source: 'ADMIN_GRANT',
        key: `admin-grant:${saved.id}`,
      });
      await expect(
        subscriptions.requireProVoice(admin.id),
      ).rejects.toMatchObject({ code: 'PRO_REQUIRED' });
    } finally {
      await model(User.name).updateOne(
        { _id: admin.id },
        { $set: { role: UserRole.ADMIN } },
      );
    }
  });

  it('rolls back history when the current membership cannot be committed', async () => {
    const body = await input();
    const assign = vi
      .spyOn(e2e.app.get(SubscriptionsService), 'assign')
      .mockRejectedValueOnce(new Error('Fixture assignment failure'));
    try {
      await expect(
        e2e.app
          .get(SubscriptionGrantsService)
          .create(admin.id, body, randomUUID()),
      ).rejects.toThrow('Fixture assignment failure');
      expect(await model(SubscriptionGrant.name).countDocuments()).toBe(0);
      expect(await model(SubscriptionMembership.name).countDocuments()).toBe(0);
    } finally {
      assign.mockRestore();
    }
  });

  it('searches email/name/ID with pagination and literal regex while omitting sensitive fields', async () => {
    const special = await createUser(e2e.mongo, {
      username: `literal+${randomUUID()}`,
      fullName: 'Grant [fixture]',
    });
    const response = await get(`${base}/users`)
      .query({ q: special.email, limit: 1 })
      .expect(200);
    expect(response.body).toMatchObject({
      total: 1,
      limit: 1,
      items: [{ id: special.id }],
    });
    expect(response.text).not.toMatch(/passwordHash|googleId|accountVersion/);
    await get(`${base}/users`)
      .query({ q: special.id.toUpperCase() })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ total: 1 }));
    await get(`${base}/users`)
      .query({ q: 'Grant [fixture]' })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ total: 1 }));
    await get(`${base}/users`).query({ limit: 1000 }).expect(400);
  });

  it('excludes page, deleted and system targets and permits any personal account role', async () => {
    for (const fields of [
      { accountType: AccountType.PAGE },
      { status: AccountStatus.DELETED },
      { status: AccountStatus.SYSTEM },
    ]) {
      const target = await createUser(e2e.mongo, fields);
      await get(`${base}/users`)
        .query({ q: target.id })
        .expect(200)
        .expect(({ body }) => expect(body).toMatchObject({ total: 0 }));
      await get(`${base}/users/${target.id}`).expect(404);
      await grant({ ...(await input()), userId: target.id }).expect(404);
    }
    const result = readGrant(await grant(await input(admin.id)).expect(200));
    expect(result.userId).toBe(admin.id);
  });

  it('validates plan, amount injection, key and reason without writing a grant', async () => {
    const body = await input();
    for (const change of [
      { planCode: 'FREE' },
      { amount: 0 },
      { durationDays: 365 },
      { actorId: member.id },
      { reason: '  ' },
      { reason: 'x'.repeat(501) },
      { catalogVersion: -1 },
      { userId: 'invalid' },
    ])
      await grant({ ...body, ...change }).expect(400);
    await http()
      .post(`${base}/grants`)
      .auth(token, { type: 'bearer' })
      .send(body)
      .expect(400);
    await grant(body, 'bad key').expect(400);
    expect(await model(SubscriptionGrant.name).countDocuments()).toBe(0);
  });

  it('grants a full Pro cycle, voice and snapshotted quotas without payment configuration or revenue', async () => {
    const config = e2e.app.get(ConfigService);
    config.set('SEPAY_PAYMENT_ENABLED', false);
    try {
      const before = Date.now();
      const saved = readGrant(await grant(await input()).expect(200));
      expect(saved).toMatchObject({
        userId: member.id,
        actorId: admin.id,
        planCode: 'PRO',
        durationDays: 30,
        textLimit: 900,
        imageLimit: 40,
      });
      expect(new Date(saved.startsAt).getTime()).toBeGreaterThanOrEqual(before);
      expect(Date.parse(saved.expiresAt) - Date.parse(saved.startsAt)).toBe(
        30 * 86_400_000,
      );
      expect(
        await e2e.app.get(SubscriptionsService).requireProVoice(member.id),
      ).toMatchObject({
        source: 'ADMIN_GRANT',
        key: `admin-grant:${saved.id}`,
        planCode: 'PRO',
      });
      await get('/api/v1/billing/me', memberToken)
        .expect(200)
        .expect(({ body }) =>
          expect(body).toMatchObject({
            membership: { source: 'ADMIN_GRANT', planCode: 'PRO' },
            usage: { text: { limit: 900 }, images: { limit: 40 } },
            recentPayments: [],
          }),
        );
      expect(await model(PaymentIntent.name).countDocuments()).toBe(0);
      expect(await model(PaymentWebhookReceipt.name).countDocuments()).toBe(0);
      await get('/api/v1/admin/payments/overview')
        .expect(200)
        .expect(({ body }) =>
          expect(body).toMatchObject({
            captured: { count: 0, totalVnd: '0' },
            membershipSnapshot: { PRO: 1 },
          }),
        );
      await get('/api/v1/admin/payments/subscriptions')
        .expect(200)
        .expect(({ body, text }) => {
          expect(body).toMatchObject({
            total: 1,
            items: [{ id: saved.id, source: 'ADMIN_GRANT', planCode: 'PRO' }],
          });
          expect(text).not.toContain('invoiceNumber');
        });
    } finally {
      config.set('SEPAY_PAYMENT_ENABLED', true);
    }
  });

  it('is idempotent under concurrent retries and rejects key reuse with another payload', async () => {
    const body = await input(),
      key = randomUUID();
    const results = await Promise.all([
      grant(body, key),
      grant(body, key),
      grant(body, key),
    ]);
    expect(results.map((res) => res.status)).toEqual([200, 200, 200]);
    expect(new Set(results.map((res) => readGrant(res).id)).size).toBe(1);
    expect(await model(SubscriptionGrant.name).countDocuments()).toBe(1);
    await grant({ ...body, planCode: 'PLUS' }, key).expect(409);
  });

  it('allows only one of two concurrent independent grants based on the same membership', async () => {
    const body = await input();
    const responses = await Promise.all([
      grant(body),
      grant({ ...body, planCode: 'PLUS' }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await model(SubscriptionGrant.name).countDocuments()).toBe(1);
  });

  it('blocks a stale membership preview after a payment capture', async () => {
    const body = await input();
    await pay(await buy()).expect(200);
    await grant(body)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUBSCRIPTION_PERIOD_CONFLICT' }),
      );
    expect(await model(SubscriptionGrant.name).countDocuments()).toBe(0);
  });

  it('reports the canonical paid membership even when a legacy payment has the same timestamp and a higher ID', async () => {
    const order = await buy('PRO');
    await pay(order).expect(200);
    const current = await model<PaymentIntent>(PaymentIntent.name)
      .findById(order.id)
      .orFail();
    await model<PaymentIntent>(PaymentIntent.name).create({
      ...current.toObject(),
      _id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      invoiceNumber: `LEGACY-${randomUUID()}`,
      paymentCode: `OLD-${randomUUID()}`,
      providerTransactionId: `LEGACY-${randomUUID()}`,
      planCode: BillingPlan.PLUS,
    });
    await get('/api/v1/admin/payments/subscriptions')
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          total: 1,
          items: [{ id: order.id, planCode: 'PRO' }],
        }),
      );
    await get('/api/v1/admin/payments/overview')
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          membershipSnapshot: { total: 1, PRO: 1, PLUS: 0 },
        }),
      );
  });

  it('rejects stale configuration and snapshots new quotas without altering earlier grants', async () => {
    const body = await input();
    const saved = readGrant(await grant(body).expect(200));
    const latest = await input();
    await http()
      .put(base)
      .auth(token, { type: 'bearer' })
      .send({
        version: 0,
        freeLimits: { textLimit: 5, imageLimit: 0 },
        plans: [
          { code: 'PLUS', priceVnd: 5000, textLimit: 10, imageLimit: 1 },
          { code: 'PRO', priceVnd: 10000, textLimit: 20, imageLimit: 2 },
        ],
      })
      .expect(200);
    await grant(latest)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUBSCRIPTION_CATALOG_CONFLICT' }),
      );
    expect(
      await e2e.app.get(SubscriptionsService).period(member.id),
    ).toMatchObject({
      key: `admin-grant:${saved.id}`,
      textLimit: 900,
      imageLimit: 40,
    });
    await grant({ ...latest, catalogVersion: 1 })
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({ textLimit: 20, imageLimit: 2 }),
      );
  });

  it('keeps a pending QR unchanged and lets its eventual payment replace an administrative grant', async () => {
    const order = await buy();
    const body = await input(),
      key = randomUUID();
    const saved = readGrant(await grant(body, key).expect(200));
    await get(`${base}/users/${member.id}`)
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({ pendingPayment: { id: order.id } }),
      );
    expect(
      await model<PaymentIntent>(PaymentIntent.name).findById(order.id),
    ).toMatchObject({ amount: 49000n, textLimit: 300, status: 'PENDING' });
    await pay(order).expect(200);
    expect(
      await e2e.app.get(SubscriptionsService).period(member.id),
    ).toMatchObject({
      key: `payment:${order.id}`,
      planCode: 'PLUS',
      textLimit: 300,
    });
    expect(readGrant(await grant(body, key).expect(200)).id).toBe(saved.id);
    expect(
      (await e2e.app.get(SubscriptionsService).period(member.id)).key,
    ).toBe(`payment:${order.id}`);
  });

  it('ignores replayed old webhook after a grant and never revives an older paid cycle after expiry', async () => {
    const order = await buy();
    const transactionId = ++transaction;
    await pay(order, transactionId).expect(200);
    const saved = readGrant(await grant(await input()).expect(200));
    await pay(order, transactionId).expect(200);
    await pay(order).expect(200);
    const service = e2e.app.get(SubscriptionsService);
    expect((await service.period(member.id)).key).toBe(
      `admin-grant:${saved.id}`,
    );
    await model(SubscriptionMembership.name).updateOne(
      { _id: member.id },
      { $set: { expiresAt: new Date(Date.now() - 1) } },
    );
    expect(await service.period(member.id)).toMatchObject({ planCode: 'FREE' });
    await expect(service.requireProVoice(member.id)).rejects.toMatchObject({
      code: 'PRO_REQUIRED',
    });
    await get('/api/v1/admin/payments/subscriptions')
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ total: 0 }));
  });

  it('resets quotas for a new grant but not on retry, and Plus has no Pro voice entitlement', async () => {
    const usage = e2e.app.get(AiUsageService);
    const first = readGrant(await grant(await input()).expect(200));
    const ticket = await usage.consume(member.id, AiFeature.MEAL_PLAN_CHAT);
    await usage.complete(ticket!);
    expect(
      await usage.summary(member.id, AiFeature.MEAL_PLAN_CHAT),
    ).toMatchObject({ used: 1 });
    const body = await input(member.id, BillingPlan.PLUS),
      key = randomUUID();
    const next = readGrant(await grant(body, key).expect(200));
    expect(next.id).not.toBe(first.id);
    expect(
      await usage.summary(member.id, AiFeature.MEAL_PLAN_CHAT),
    ).toMatchObject({ used: 0, limit: 300 });
    const second = await usage.consume(member.id, AiFeature.MEAL_PLAN_CHAT);
    await usage.complete(second!);
    await grant(body, key).expect(200);
    expect(
      await usage.summary(member.id, AiFeature.MEAL_PLAN_CHAT),
    ).toMatchObject({ used: 1 });
    await expect(
      usage.consumeVoice(member.id, AiFeature.MEAL_PLAN_CHAT),
    ).rejects.toMatchObject({ code: 'PRO_REQUIRED' });
  });

  it('records grant history and successful/failed admin audit events without exposing the idempotency hash', async () => {
    const body = await input();
    const saved = readGrant(await grant(body).expect(200));
    await grant(body).expect(409);
    await get(`${base}/users/${member.id}`)
      .expect(200)
      .expect(({ body, text }) => {
        expect(body).toMatchObject({
          recentGrants: [
            {
              id: saved.id,
              actorId: admin.id,
              reason: 'Customer support fixture',
            },
          ],
        });
        expect(text).not.toMatch(/payloadHash|requestKey/);
      });
    await vi.waitFor(async () => {
      const logs = await model<SystemLog>(SystemLog.name).find({
        actorId: admin.id,
        resourceType: 'SUBSCRIPTION_PLANS',
        method: 'POST',
      });
      expect(
        logs.some(
          (log) => log.outcome === 'SUCCESS' && log.targetId === saved.id,
        ),
      ).toBe(true);
      expect(logs.some((log) => log.outcome === 'FAILURE')).toBe(true);
    });
  });
});
