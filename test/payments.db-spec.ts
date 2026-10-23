import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  PaymentsController,
  PaymentReconciliationController,
  SePayWebhookController,
} from '../src/payments/payments.controller';
import { PaymentsService } from '../src/payments/payments.service';
import { SePayProvider } from '../src/payments/sepay.provider';
import { SePayWebhookGuard } from '../src/payments/sepay-webhook.guard';
import type { PaymentDto } from '../src/payments/payment.dto';
import { PaymentEventsService } from '../src/payments/payment-events.service';
import { PaymentStreamController } from '../src/payments/payment-stream.controller';
import * as paymentCodes from '../src/payments/payment-code';

describe('SePay payments with PostgreSQL and HTTP', () => {
  const schema = `vedora_payment_test_${randomUUID().replaceAll('-', '')}`;
  const secret = 'sepay-integration-webhook-secret';
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
    BILLING_PRO_PRICE_VND: 49000,
    BILLING_PREMIUM_PRICE_VND: 99000,
    BILLING_DURATION_DAYS: 30,
  };
  let db: PrismaClient;
  let app: INestApplication<App>;
  let service: PaymentsService;
  let jwt: JwtService;
  let counter = 1000;
  const path = '/api/v1';
  const webhookPath = `${path}/payments/sepay/bank-transfer-webhook`;
  const makeUser = async (role: 'USER' | 'ADMIN' = 'USER') => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 15);
    const user = await db.user.create({
      data: {
        username: `pay${suffix}`,
        email: `${suffix}@payments.test`,
        fullName: 'Payment Test',
        role,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    return {
      ...user,
      token: await jwt.signAsync({ sub: user.id, username: user.username }),
    };
  };
  const create = async (
    user: { id: string },
    planCode: 'PRO' | 'PREMIUM' = 'PRO',
    key = randomUUID(),
  ) => service.create(user.id, planCode, key);
  const event = (
    intent: PaymentDto,
    overrides: Record<string, unknown> = {},
  ) => ({
    id: ++counter,
    gateway: 'Vietcombank',
    accountNumber: '0012345678',
    subAccount: null,
    transactionDate: '2026-10-23 10:20:30',
    code: intent.paymentCode,
    transferType: 'in',
    transferAmount: Number(intent.amount),
    referenceCode: `TEST-${counter}`,
    content: 'Private sender',
    ...overrides,
  });
  const callback = (body: object, credential = `Apikey ${secret}`) =>
    request(app.getHttpServer())
      .post(webhookPath)
      .set('Authorization', credential)
      .send(body);

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error(
        'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
      );
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('schema', schema);
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
      ],
      {
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: 'pipe',
        timeout: 45_000,
      },
    );
    db = new PrismaClient({ datasourceUrl: url.toString() });
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'sepay-db-test-jwt-secret' })],
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
        { provide: PrismaService, useValue: db },
        { provide: ConfigService, useValue: new ConfigService(settings) },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    await app.listen(0, '127.0.0.1');
    service = app.get(PaymentsService);
    jwt = app.get(JwtService);
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.$disconnect();
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the env prefix with six characters and puts the complete short code in QR', async () => {
    const config = app.get(ConfigService);
    config.set('SEPAY_PAYMENT_CODE_PREFIX', 'PAY');
    try {
      const payment = await create(await makeUser());
      expect(payment.paymentCode).toMatch(/^PAY[A-Z0-9]{6}$/);
      expect(payment.qr!.transferContent).toBe(payment.paymentCode);
      expect(new URL(payment.qr!.imageUrl).searchParams.get('des')).toBe(
        payment.paymentCode,
      );
      await callback(event(payment)).expect(200);
      expect(
        (
          await db.paymentIntent.findUniqueOrThrow({
            where: { id: payment.id },
          })
        ).status,
      ).toBe('SUCCEEDED');
    } finally {
      config.set('SEPAY_PAYMENT_CODE_PREFIX', 'VED');
    }
  });

  it('retries a real unique-code collision without consuming the key or duplicating writes', async () => {
    const owner = await makeUser(),
      user = await makeUser();
    const stored = await create(owner);
    await service.cancel(stored.id, owner.id);
    const generate = vi.spyOn(paymentCodes, 'generatePaymentCode');
    generate.mockReturnValueOnce(stored.paymentCode);
    const key = randomUUID();
    const payment = await create(user, 'PRO', key);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(payment.paymentCode).toMatch(/^VED[A-Z0-9]{6}$/);
    expect(payment.paymentCode).not.toBe(stored.paymentCode);
    expect((await create(user, 'PRO', key)).id).toBe(payment.id);
    expect(await db.paymentIntent.count({ where: { userId: user.id } })).toBe(
      1,
    );
    expect(await db.paymentRequest.count({ where: { actorId: user.id } })).toBe(
      1,
    );
    expect(
      await db.paymentAudit.count({
        where: { intentId: payment.id, action: 'CREATED' },
      }),
    ).toBe(1);
  });

  it('bounds collision retries and lets the same key succeed after exhaustion', async () => {
    const stored = await create(await makeUser()),
      user = await makeUser(),
      key = randomUUID();
    const generate = vi
      .spyOn(paymentCodes, 'generatePaymentCode')
      .mockReturnValue(stored.paymentCode);
    await expect(create(user, 'PRO', key)).rejects.toMatchObject({
      status: 503,
      response: { code: 'PAYMENT_CODE_UNAVAILABLE' },
    });
    expect(generate).toHaveBeenCalledTimes(5);
    expect(await db.paymentIntent.count({ where: { userId: user.id } })).toBe(
      0,
    );
    expect(await db.paymentRequest.count({ where: { actorId: user.id } })).toBe(
      0,
    );
    generate.mockRestore();
    expect((await create(user, 'PRO', key)).status).toBe('PENDING');
  });

  it('resolves a short-code collision between concurrent purchases by different payers', async () => {
    const one = await makeUser(),
      two = await makeUser();
    const stored = new Set(
      (await db.paymentIntent.findMany({ select: { paymentCode: true } })).map(
        (row) => row.paymentCode,
      ),
    );
    const unused: string[] = [];
    for (let value = 0; unused.length < 2; value++) {
      const candidate = `VED${value.toString(36).padStart(6, '0').toUpperCase()}`;
      if (!stored.has(candidate)) unused.push(candidate);
    }
    const generate = vi
      .spyOn(paymentCodes, 'generatePaymentCode')
      .mockReturnValueOnce(unused[0])
      .mockReturnValueOnce(unused[0])
      .mockReturnValue(unused[1]);
    const payments = await Promise.all([create(one), create(two)]);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(new Set(payments.map((payment) => payment.paymentCode))).toEqual(
      new Set(unused),
    );
    expect(
      await db.paymentIntent.count({
        where: { userId: { in: [one.id, two.id] } },
      }),
    ).toBe(2);
    expect(
      await db.paymentRequest.count({
        where: { actorId: { in: [one.id, two.id] } },
      }),
    ).toBe(2);
    expect(
      await db.paymentAudit.count({
        where: {
          intentId: { in: payments.map((payment) => payment.id) },
          action: 'CREATED',
        },
      }),
    ).toBe(2);
  });

  it('does not retry unrelated unique constraints', async () => {
    const owner = await makeUser(),
      user = await makeUser();
    await create(owner);
    await db.$executeRawUnsafe(
      `CREATE UNIQUE INDEX reject_test_same_price ON payment_intents (amount) WHERE user_id IN ('${owner.id}'::uuid, '${user.id}'::uuid)`,
    );
    const generate = vi.spyOn(paymentCodes, 'generatePaymentCode');
    try {
      await expect(create(user)).rejects.toMatchObject({
        code: 'P2002',
        meta: { target: ['amount'] },
      });
      expect(generate).toHaveBeenCalledOnce();
    } finally {
      await db.$executeRawUnsafe('DROP INDEX reject_test_same_price');
    }
  });

  it('requires provider code and never infers a payment from transfer content', async () => {
    const user = await makeUser(),
      payment = await create(user);
    for (const code of [null, '', '   ', 'VEDUNKNOWN']) {
      const body = event(payment, { code, content: payment.paymentCode });
      await callback(body).expect(200);
      expect(
        (
          await db.paymentWebhookReceipt.findFirstOrThrow({
            where: { providerTransactionId: `BANK-${body.id}` },
          })
        ).outcome,
      ).toBe(
        code?.trim() ? 'PAYMENT_INTENT_NOT_FOUND' : 'PAYMENT_CODE_MISSING',
      );
    }
    expect((await service.get(payment.id, user.id)).status).toBe('PENDING');
    expect((await service.overview(user.id)).membership.planCode).toBe('FREE');
    expect(
      await db.paymentLedger.count({ where: { intentId: payment.id } }),
    ).toBe(0);
  });

  it('publishes capture only after committed payment, ledger and membership are visible', async () => {
    const user = await makeUser(),
      payment = await create(user);
    let visible: unknown;
    const publish = vi
      .spyOn(app.get(PaymentEventsService), 'publish')
      .mockImplementation(async (change) => {
        visible = {
          change,
          status: (
            await db.paymentIntent.findUniqueOrThrow({
              where: { id: payment.id },
            })
          ).status,
          ledgerCount: await db.paymentLedger.count({
            where: { intentId: payment.id },
          }),
          paymentId: (
            await db.membership.findUniqueOrThrow({
              where: { userId: user.id },
            })
          ).paymentId,
        };
      });
    await callback(event(payment)).expect(200);
    expect(publish).toHaveBeenCalledOnce();
    expect(visible).toEqual({
      change: { userId: user.id, intentId: payment.id },
      status: 'SUCCEEDED',
      ledgerCount: 1,
      paymentId: payment.id,
    });
  });

  it('does not publish ignored or duplicate callbacks', async () => {
    const user = await makeUser(),
      payment = await create(user),
      body = event(payment);
    const publish = vi
      .spyOn(app.get(PaymentEventsService), 'publish')
      .mockResolvedValue();
    await callback({ ...body, transferAmount: 1 }).expect(200);
    expect(publish).not.toHaveBeenCalled();
    await callback(body).expect(200);
    await callback(body).expect(200);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('publishes cancellation after commit and never republishes idempotent cancellation', async () => {
    const user = await makeUser(),
      payment = await create(user);
    let visible: unknown;
    const publish = vi
      .spyOn(app.get(PaymentEventsService), 'publish')
      .mockImplementation(async () => {
        visible = (
          await db.paymentIntent.findUniqueOrThrow({
            where: { id: payment.id },
          })
        ).status;
      });
    await service.cancel(payment.id, user.id);
    await service.cancel(payment.id, user.id);
    expect(publish).toHaveBeenCalledOnce();
    expect(visible).toBe('CANCELLED');
  });

  it('does not fail a committed capture if the realtime service throws', async () => {
    const user = await makeUser(),
      payment = await create(user);
    vi.spyOn(app.get(PaymentEventsService), 'publish').mockRejectedValue(
      new Error('Redis unavailable'),
    );
    await callback(event(payment)).expect(200, { success: true });
    expect((await service.get(payment.id, user.id)).status).toBe('SUCCEEDED');
    expect(
      await db.paymentLedger.count({ where: { intentId: payment.id } }),
    ).toBe(1);
  });

  it('rejects anonymous and non-owner streams before sending SSE headers', async () => {
    const user = await makeUser(),
      other = await makeUser('ADMIN'),
      payment = await create(user);
    await request(app.getHttpServer())
      .get(`${path}/payment-intents/${payment.id}/events`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`${path}/payment-intents/${payment.id}/events`)
      .auth(other.token, { type: 'bearer' })
      .expect(404);
    await request(app.getHttpServer())
      .get(`${path}/payment-intents/${randomUUID()}/events`)
      .auth(user.token, { type: 'bearer' })
      .expect(404);
  });

  it('opens an authenticated private stream and declares fallback when Redis is disabled', async () => {
    const user = await makeUser(),
      payment = await create(user);
    const abort = new AbortController();
    try {
      const response = await fetch(
        `${await app.getUrl()}${path}/payment-intents/${payment.id}/events`,
        {
          headers: { Authorization: `Bearer ${user.token}` },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('x-accel-buffering')).toBe('no');
      const reader = response.body!.getReader(),
        decoder = new TextDecoder();
      let text = '';
      while (!text.includes('event: stream.unavailable')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      expect(text).toContain('event: stream.unavailable');
      expect(text).not.toContain(user.email);
      expect(text).not.toContain(user.token);
    } finally {
      abort.abort();
    }
  });

  it('publishes confirmed server prices and no paid privileges', () => {
    expect(service.catalog().plans).toEqual([
      { code: 'PRO', name: 'Pro', priceVnd: '49000', durationDays: 30 },
      { code: 'PREMIUM', name: 'Premium', priceVnd: '99000', durationDays: 30 },
    ]);
  });
  it('creates QR from server price and snapshots the contract', async () => {
    const user = await makeUser();
    const res = await request(app.getHttpServer())
      .post(`${path}/billing/payment-intents`)
      .auth(user.token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ planCode: 'PRO' })
      .expect(200);
    const payment = res.body as PaymentDto;
    expect(payment.amount).toBe('49000');
    expect(payment.status).toBe('PENDING');
    expect(new URL(payment.qr!.imageUrl).searchParams.get('acc')).toBe(
      '0012345678',
    );
    expect(res.headers['cache-control']).toContain('no-store');
    expect((await service.overview(user.id)).membership.planCode).toBe('FREE');
  });
  it('rejects client amount, missing key, unsupported plan and unauthenticated writes', async () => {
    const user = await makeUser();
    await request(app.getHttpServer())
      .post(`${path}/billing/payment-intents`)
      .send({ planCode: 'PRO' })
      .expect(401);
    for (const body of [{ planCode: 'PRO', amount: '1' }, { planCode: 'VIP' }])
      await request(app.getHttpServer())
        .post(`${path}/billing/payment-intents`)
        .auth(user.token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .expect(400);
    await request(app.getHttpServer())
      .post(`${path}/billing/payment-intents`)
      .auth(user.token, { type: 'bearer' })
      .send({ planCode: 'PRO' })
      .expect(400);
  });
  it('reuses same key/body and binds the key to its original body', async () => {
    const user = await makeUser(),
      key = randomUUID();
    const payment = await create(user, 'PRO', key);
    expect((await create(user, 'PRO', key)).id).toBe(payment.id);
    await expect(create(user, 'PREMIUM', key)).rejects.toMatchObject({
      status: 409,
    });
    expect(await db.paymentIntent.count({ where: { userId: user.id } })).toBe(
      1,
    );
  });
  it('concurrent same/different keys produce one pending intent', async () => {
    const user = await makeUser(),
      key = randomUUID();
    const same = await Promise.all(
      Array.from({ length: 6 }, () => create(user, 'PRO', key)),
    );
    const other = await Promise.all(
      Array.from({ length: 4 }, () => create(user)),
    );
    expect(new Set([...same, ...other].map((item) => item.id)).size).toBe(1);
    expect(await db.paymentRequest.count({ where: { actorId: user.id } })).toBe(
      5,
    );
  });
  it('rejects another plan while a payment is pending', async () => {
    const user = await makeUser();
    await create(user);
    await expect(create(user, 'PREMIUM')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('keeps price, duration and receiving account snapshots after configuration changes', async () => {
    const user = await makeUser(),
      payment = await create(user);
    const config = app.get(ConfigService);
    config.set('BILLING_PRO_PRICE_VND', 59000);
    config.set('BILLING_DURATION_DAYS', 60);
    config.set('SEPAY_QR_ACCOUNT_NUMBER', 'NEWACCOUNT');
    try {
      const stored = await service.get(payment.id, user.id);
      expect(stored.amount).toBe('49000');
      expect(stored.qr?.accountNumber).toBe('0012345678');
      await expect(create(user)).rejects.toMatchObject({ status: 409 });
      await callback(event(payment)).expect(200);
      const membership = await db.membership.findUniqueOrThrow({
        where: { userId: user.id },
      });
      expect(
        membership.expiresAt.getTime() - membership.startsAt.getTime(),
      ).toBe(30 * 86_400_000);
    } finally {
      config.set('BILLING_PRO_PRICE_VND', 49000);
      config.set('BILLING_DURATION_DAYS', 30);
      config.set('SEPAY_QR_ACCOUNT_NUMBER', '0012345678');
    }
  });
  it('protects ownership even from another admin and prevents private response leakage', async () => {
    const user = await makeUser(),
      other = await makeUser('ADMIN'),
      payment = await create(user);
    await request(app.getHttpServer())
      .get(`${path}/payment-intents/${payment.id}`)
      .auth(other.token, { type: 'bearer' })
      .expect(404);
    await request(app.getHttpServer())
      .post(`${path}/payment-intents/${payment.id}/cancel`)
      .auth(other.token, { type: 'bearer' })
      .expect(404);
    expect(JSON.stringify(payment)).not.toContain(user.email);
    expect(payment).not.toHaveProperty('userId');
    expect(payment).not.toHaveProperty('providerTransactionId');
    expect(payment.qr).not.toHaveProperty('userId');
    expect(payment.qr).not.toHaveProperty('activeIntentKey');
    expect(payment.qr).not.toHaveProperty('providerReference');
  });
  it('rejects wrong webhook credentials before any write', async () => {
    const user = await makeUser(),
      payment = await create(user),
      body = event(payment);
    await callback(body, 'Bearer fake').expect(401);
    await callback(body, 'Apikey wrong-secret-of-valid-length').expect(401);
    expect(
      await db.paymentWebhookReceipt.count({
        where: { providerTransactionId: `BANK-${body.id}` },
      }),
    ).toBe(0);
    expect((await service.get(payment.id, user.id)).status).toBe('PENDING');
  });
  it('rejects malformed authenticated payload without capture', async () => {
    const user = await makeUser(),
      payment = await create(user);
    for (const change of [
      { transferAmount: 1.5 },
      { transactionDate: '2026-02-30 10:00:00' },
      { accountNumber: 123 },
      { id: Number.MAX_SAFE_INTEGER + 1 },
    ])
      await callback(event(payment, change)).expect(400);
    expect(await db.paymentLedger.count({ where: { userId: user.id } })).toBe(
      0,
    );
  });
  it.each([
    [{ transferType: 'out' }, 'NOT_INCOMING'],
    [{ code: null }, 'PAYMENT_CODE_MISSING'],
    [{ code: 'VEDUNKNOWN' }, 'PAYMENT_INTENT_NOT_FOUND'],
    [{ gateway: 'OtherBank' }, 'ACCOUNT_MISMATCH'],
    [{ accountNumber: '12345678' }, 'ACCOUNT_MISMATCH'],
    [{ transferAmount: 48000 }, 'AMOUNT_MISMATCH'],
    [{ transferAmount: 50000 }, 'AMOUNT_MISMATCH'],
  ])(
    'acknowledges ignored callbacks and records reason %s',
    async (change, reason) => {
      const user = await makeUser(),
        payment = await create(user),
        body = event(payment, change);
      await callback(body).expect(200, { success: true });
      expect(
        (
          await db.paymentWebhookReceipt.findFirstOrThrow({
            where: { providerTransactionId: `BANK-${body.id}` },
          })
        ).outcome,
      ).toBe(reason);
      expect((await service.get(payment.id, user.id)).status).toBe('PENDING');
      expect(await db.paymentLedger.count({ where: { userId: user.id } })).toBe(
        0,
      );
    },
  );
  it('captures exact payment and activates membership atomically from capture time', async () => {
    const user = await makeUser(),
      payment = await create(user),
      before = Date.now();
    await callback(event(payment, { gateway: 'vietcombank' })).expect(200);
    const stored = await db.paymentIntent.findUniqueOrThrow({
      where: { id: payment.id },
    });
    const membership = await db.membership.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(stored.status).toBe('SUCCEEDED');
    expect(stored.activeIntentKey).toBeNull();
    expect(membership.planCode).toBe('PRO');
    expect(membership.startsAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(membership.expiresAt.getTime() - membership.startsAt.getTime()).toBe(
      30 * 86_400_000,
    );
    expect(stored.paidAt!.toISOString()).toBe('2026-10-23T03:20:30.000Z');
    expect((await service.get(payment.id, user.id)).qr).toBeNull();
    expect(
      await db.paymentLedger.count({ where: { intentId: payment.id } }),
    ).toBe(1);
    expect(
      await db.paymentAudit.count({
        where: { intentId: payment.id, action: 'CAPTURED' },
      }),
    ).toBe(1);
  });
  it('matches the configured VA exactly via subAccount', async () => {
    const user = await makeUser(),
      payment = await create(user);
    await callback(
      event(payment, { accountNumber: 'PARENT', subAccount: '0012345678' }),
    ).expect(200);
    expect((await service.get(payment.id, user.id)).status).toBe('SUCCEEDED');
  });
  it('concurrent repeated callbacks capture and activate only once', async () => {
    const user = await makeUser(),
      payment = await create(user),
      body = event(payment);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => callback(body)),
    );
    expect(responses.map((item) => item.status)).toEqual(Array(6).fill(200));
    expect(await db.paymentLedger.count({ where: { userId: user.id } })).toBe(
      1,
    );
    expect(
      await db.paymentAudit.count({
        where: { intentId: payment.id, action: 'CAPTURED' },
      }),
    ).toBe(1);
    const original = await db.membership.findUniqueOrThrow({
      where: { userId: user.id },
    });
    await callback(body).expect(200);
    expect(
      await db.membership.findUnique({ where: { userId: user.id } }),
    ).toEqual(original);
  });
  it('does not use one provider event to pay for two users', async () => {
    const one = await makeUser(),
      two = await makeUser(),
      p1 = await create(one),
      p2 = await create(two),
      id = ++counter;
    await Promise.all([
      callback(event(p1, { id })),
      callback(event(p2, { id })),
    ]);
    expect(
      await db.paymentLedger.count({
        where: { providerTransactionId: `BANK-${id}` },
      }),
    ).toBe(1);
    expect(
      await db.paymentIntent.count({
        where: { id: { in: [p1.id, p2.id] }, status: 'SUCCEEDED' },
      }),
    ).toBe(1);
    expect(
      await db.paymentWebhookReceipt.count({
        where: {
          providerTransactionId: `BANK-${id}`,
          outcome: 'TRANSACTION_ALREADY_USED',
        },
      }),
    ).toBe(1);
  });
  it('does not capture a second transaction for an already-paid intent', async () => {
    const user = await makeUser(),
      payment = await create(user);
    await callback(event(payment)).expect(200);
    const body = event(payment);
    await callback(body).expect(200);
    expect(
      await db.paymentLedger.count({ where: { intentId: payment.id } }),
    ).toBe(1);
    expect(
      (
        await db.paymentWebhookReceipt.findFirstOrThrow({
          where: { providerTransactionId: `BANK-${body.id}` },
        })
      ).outcome,
    ).toBe('PAYMENT_INTENT_ALREADY_SUCCEEDED');
  });
  it('cancels idempotently, preserves old keys, and refuses late payment resurrection', async () => {
    const user = await makeUser(),
      key = randomUUID(),
      payment = await create(user, 'PRO', key);
    await service.cancel(payment.id, user.id);
    await service.cancel(payment.id, user.id);
    await callback(event(payment)).expect(200);
    expect((await service.get(payment.id, user.id)).status).toBe('CANCELLED');
    expect((await create(user, 'PRO', key)).id).toBe(payment.id);
    expect((await create(user)).id).not.toBe(payment.id);
    expect(
      await db.paymentLedger.count({ where: { intentId: payment.id } }),
    ).toBe(0);
  });
  it('serializes cancellation against capture without an inconsistent state', async () => {
    const user = await makeUser(),
      payment = await create(user);
    await Promise.allSettled([
      service.cancel(payment.id, user.id),
      service.bankWebhook(event(payment)),
    ]);
    const stored = await db.paymentIntent.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(
      await db.paymentLedger.count({ where: { intentId: payment.id } }),
    ).toBe(stored.status === 'SUCCEEDED' ? 1 : 0);
    expect(['SUCCEEDED', 'CANCELLED']).toContain(stored.status);
    expect(stored.activeIntentKey).toBeNull();
  });
  it('new purchase replaces remaining old period without stacking or privileges', async () => {
    const user = await makeUser(),
      first = await create(user);
    await callback(event(first)).expect(200);
    await db.membership.update({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() + 90 * 86_400_000) },
    });
    const second = await create(user, 'PREMIUM');
    await callback(event(second)).expect(200);
    const membership = await db.membership.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(membership.planCode).toBe('PREMIUM');
    expect(membership.paymentId).toBe(second.id);
    expect(membership.expiresAt.getTime() - membership.startsAt.getTime()).toBe(
      30 * 86_400_000,
    );
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).role,
    ).toBe('USER');
    expect(await db.paymentLedger.count({ where: { userId: user.id } })).toBe(
      2,
    );
  });
  it('expired membership reads as FREE without jobs', async () => {
    const user = await makeUser(),
      payment = await create(user);
    await callback(event(payment)).expect(200);
    await db.membership.update({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await service.overview(user.id)).membership.planCode).toBe('FREE');
  });
  it('retains financial history after user deletion and ignores unavailable recipients', async () => {
    const user = await makeUser(),
      payment = await create(user);
    await db.user.delete({ where: { id: user.id } });
    const body = event(payment);
    await callback(body).expect(200);
    expect(
      (
        await db.paymentWebhookReceipt.findFirstOrThrow({
          where: { providerTransactionId: `BANK-${body.id}` },
        })
      ).outcome,
    ).toBe('ACCOUNT_UNAVAILABLE');
    expect(await db.paymentIntent.count({ where: { id: payment.id } })).toBe(1);
  });
  it('rolls back payment, ledger, audit and receipt if membership write fails', async () => {
    const publish = vi
      .spyOn(app.get(PaymentEventsService), 'publish')
      .mockResolvedValue();
    const user = await makeUser(),
      payment = await create(user, 'PREMIUM'),
      body = event(payment);
    await db.$executeRawUnsafe(
      `ALTER TABLE memberships ADD CONSTRAINT reject_test_premium CHECK (plan_code <> 'PREMIUM') NOT VALID`,
    );
    try {
      await callback(body).expect(500);
      expect(publish).not.toHaveBeenCalled();
      expect((await service.get(payment.id, user.id)).status).toBe('PENDING');
      expect(
        await db.paymentLedger.count({ where: { intentId: payment.id } }),
      ).toBe(0);
      expect(
        await db.paymentAudit.count({
          where: { intentId: payment.id, action: 'CAPTURED' },
        }),
      ).toBe(0);
      expect(
        await db.paymentWebhookReceipt.count({
          where: { providerTransactionId: `BANK-${body.id}` },
        }),
      ).toBe(0);
    } finally {
      await db.$executeRawUnsafe(
        'ALTER TABLE memberships DROP CONSTRAINT reject_test_premium',
      );
    }
    await callback(body).expect(200);
    expect(publish).toHaveBeenCalledOnce();
    expect(
      await db.paymentLedger.count({ where: { intentId: payment.id } }),
    ).toBe(1);
  });
  it('restricts sanitized receipt reconciliation to admins', async () => {
    const user = await makeUser(),
      admin = await makeUser('ADMIN');
    await request(app.getHttpServer())
      .get(`${path}/admin/payments/webhook-receipts`)
      .auth(user.token, { type: 'bearer' })
      .expect(403);
    const res = await request(app.getHttpServer())
      .get(`${path}/admin/payments/webhook-receipts`)
      .auth(admin.token, { type: 'bearer' })
      .expect(200);
    expect((res.body as unknown[]).length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(res.body)).not.toContain('Private sender');
  });
});
