import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import {
  AccountStatus,
  BillingPlan,
  PaymentIntent,
  PaymentStatus,
  PaymentWebhookReceipt,
  User,
  UserRole,
} from '@src/mongo/models.js';
import { SubscriptionsModule } from '@src/subscriptions/subscriptions.module.js';
import { AdminPaymentsController } from '@src/payments/admin/admin-payments.controller.js';
import { AdminPaymentsService } from '@src/payments/admin/admin-payments.service.js';
import {
  AdminPaymentListDto,
  AdminSubscriptionQueryDto,
} from '@src/payments/admin/admin-payment-query.dto.js';
import { AppExceptionFilter } from '@src/common/exceptions/app-exception.filter.js';
import { configureApp } from '@src/app.setup.js';
import { createUser } from '@test/support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';

interface ListBody {
  items: { id: string }[];
  total: number;
}

describe('Admin payment flows (contract matrix)', () => {
  let app: INestApplication<App>;
  let db: MongoService;
  let service: AdminPaymentsService;
  let adminToken: string;
  let memberId: string;
  const path = '/api/v1/admin/payments';
  const range = { from: '2026-10-01', to: '2026-10-02' };
  const now = new Date('2026-10-02T10:00:00Z');
  const models = () => ({
    intents: db.connection.model<PaymentIntent>(PaymentIntent.name),
    receipts: db.connection.model<PaymentWebhookReceipt>(
      PaymentWebhookReceipt.name,
    ),
    users: db.connection.model<User>(User.name),
  });

  function seed(extra: Partial<PaymentIntent> = {}) {
    const id = randomUUID();
    return models().intents.create({
      _id: id,
      userId: memberId,
      planCode: BillingPlan.PLUS,
      planVersion: 2,
      durationDays: 30,
      amount: 49000n,
      currency: 'VND',
      status: PaymentStatus.PENDING,
      invoiceNumber: `INVOICE-${id}`,
      paymentCode: `VED${id.slice(0, 6).toUpperCase()}`,
      bankCode: 'VCB',
      bankGateway: 'Vietcombank',
      accountNumber: '0012345678',
      accountHolder: 'MERCHANT',
      storeName: 'Vedora',
      transferContent: 'SNAPSHOT',
      createdAt: new Date('2026-10-01T05:00:00Z'),
      ...extra,
    });
  }

  function captured(capturedAt: Date, extra: Partial<PaymentIntent> = {}) {
    return seed({
      status: PaymentStatus.SUCCEEDED,
      capturedAt,
      paidAt: capturedAt,
      providerTransactionId: `BANK-${randomUUID()}`,
      ...extra,
    });
  }

  function listQuery(extra: Partial<AdminPaymentListDto> = {}) {
    return Object.assign(new AdminPaymentListDto(), range, extra);
  }

  function adminGet(route: string) {
    return request(app.getHttpServer())
      .get(`${path}/${route}`)
      .auth(adminToken, { type: 'bearer' });
  }

  async function makeUser(extra: Partial<User> = {}) {
    const id = randomUUID().replaceAll('-', '');
    return createUser(db, {
      username: `adm${id}`,
      email: `${id}@admin-flows.fixture`,
      ...extra,
    });
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        MongoModule.forTest(createTestMongoUrl('admin_payment_flows')),
        SubscriptionsModule,
        JwtModule.register({
          global: true,
          secret: 'admin-payment-flows-secret',
        }),
      ],
      controllers: [AdminPaymentsController],
      providers: [
        AdminPaymentsService,
        {
          provide: ConfigService,
          useValue: new ConfigService({ API_PREFIX: 'api/v1' }),
        },
        { provide: APP_FILTER, useClass: AppExceptionFilter },
      ],
    }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(MongoService);
    await prepareTestDatabase(app);
    service = app.get(AdminPaymentsService);
    const admin = await makeUser({ role: UserRole.ADMIN });
    const member = await makeUser();
    memberId = member.id;
    adminToken = app
      .get(JwtService)
      .sign({ sub: admin.id, username: admin.username });
  });

  beforeEach(async () => {
    await Promise.all([
      models().intents.deleteMany({}),
      models().receipts.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (app) {
      await dropTestDatabase(app);
      await app.close();
    }
  });

  describe('exact search q', () => {
    it.each(['orders', 'overview', 'export'])(
      'rejects a whitespace-only q on %s instead of silently ignoring it',
      async (route) => {
        await seed();

        const response = await adminGet(
          `${route}?from=${range.from}&to=${range.to}&q=%20%20%20`,
        );

        expect(response.status).toBe(400);
      },
    );

    it('trims surrounding whitespace before matching a payment code exactly', async () => {
      const intent = await seed();

      const response = await adminGet(
        `orders?from=${range.from}&to=${range.to}&q=${encodeURIComponent(
          `  ${intent.paymentCode}  `,
        )}`,
      ).expect(200);

      const body = response.body as ListBody;
      expect(body.total).toBe(1);
      expect(body.items[0].id).toBe(intent.id);
    });

    it('does not match a payment code with one character missing (exact, not fuzzy)', async () => {
      const intent = await seed();

      const result = await service.orders(
        listQuery({ q: intent.paymentCode.slice(0, -1) }),
      );

      expect(result.total).toBe(0);
    });
  });

  describe('Bangkok day range boundaries', () => {
    it('includes an order created at the first instant of from (00:00 UTC+7)', async () => {
      const intent = await seed({
        createdAt: new Date('2026-09-30T17:00:00.000Z'),
      });

      const result = await service.orders(listQuery());

      expect(result.items.map((row) => row.id)).toContain(intent.id);
    });

    it('excludes an order created one millisecond before from (UTC+7)', async () => {
      const control = await seed();
      await seed({ createdAt: new Date('2026-09-30T16:59:59.999Z') });

      const result = await service.orders(listQuery());

      expect(result.items.map((row) => row.id)).toEqual([control.id]);
    });

    it('includes an order created at the last millisecond of to (23:59:59.999 UTC+7)', async () => {
      await seed({ createdAt: new Date('2026-10-02T16:59:59.999Z') });

      const result = await service.orders(listQuery());

      expect(result.total).toBe(1);
    });

    it('excludes an order created at the first instant after to (UTC+7)', async () => {
      const control = await seed();
      await seed({ createdAt: new Date('2026-10-02T17:00:00.000Z') });

      const result = await service.orders(listQuery());

      expect(result.items.map((row) => row.id)).toEqual([control.id]);
    });

    it('buckets a capture at 00:30 Bangkok into that Bangkok day, not the UTC day', async () => {
      await captured(new Date('2026-10-01T17:30:00Z'));

      const overview = await service.overview(range, now);

      const day = overview.daily.find((row) => row.capturedOrders > 0);
      expect(day?.date).toBe('2026-10-02');
      expect(day?.confirmedVnd).toBe('49000');
    });

    it('counts revenue by capture date even when the order was created before the range', async () => {
      await captured(new Date('2026-10-01T05:00:00Z'), {
        createdAt: new Date('2026-09-01T05:00:00Z'),
      });

      const overview = await service.overview(range, now);

      expect(overview.createdOrders.total).toBe(0);
      expect(overview.captured).toMatchObject({ count: 1, totalVnd: '49000' });
    });

    it('accepts a range of exactly 90 inclusive days', async () => {
      await adminGet('orders?from=2026-07-05&to=2026-10-02').expect(200);
    });

    it('rejects a range of 91 inclusive days', async () => {
      await adminGet('orders?from=2026-07-04&to=2026-10-02').expect(400);
    });

    it('rejects a descending range', async () => {
      await adminGet('orders?from=2026-10-02&to=2026-10-01').expect(400);
    });
  });

  describe('revenue aggregation', () => {
    it('counts a buyer of both plans once overall and once per plan', async () => {
      await captured(new Date('2026-10-01T05:00:00Z'));
      await captured(new Date('2026-10-01T06:00:00Z'), {
        planCode: BillingPlan.PRO,
        amount: 99000n,
      });

      const overview = await service.overview(range, now);

      expect(overview.captured.buyers).toBe(1);
      expect(overview.captured.totalVnd).toBe('148000');
      const plans = [...overview.captured.byPlan].sort((a, b) =>
        String(a.planCode).localeCompare(String(b.planCode)),
      );
      expect(plans).toEqual([
        { planCode: 'PLUS', count: 1, totalVnd: '49000', buyers: 1 },
        { planCode: 'PRO', count: 1, totalVnd: '99000', buyers: 1 },
      ]);
    });

    it('never counts a cancelled order as confirmed revenue', async () => {
      await seed({
        status: PaymentStatus.CANCELLED,
        cancelledAt: new Date('2026-10-01T06:00:00Z'),
      });

      const overview = await service.overview(range, now);

      expect(overview.createdOrders.CANCELLED).toBe(1);
      expect(overview.captured).toMatchObject({ count: 0, totalVnd: '0' });
    });
  });

  describe('current subscriptions', () => {
    it('does not list a user under PRO when their latest active purchase is PLUS', async () => {
      await captured(new Date(now.getTime() - 2 * 86_400_000), {
        planCode: BillingPlan.PRO,
        amount: 99000n,
      });
      const latest = await captured(new Date(now.getTime() - 86_400_000));

      const pro = await service.activeSubscriptions(
        Object.assign(new AdminSubscriptionQueryDto(), { plan: 'PRO' }),
        now,
      );
      const plus = await service.activeSubscriptions(
        Object.assign(new AdminSubscriptionQueryDto(), { plan: 'PLUS' }),
        now,
      );

      expect(pro.total).toBe(0);
      expect(plus.items.map((row) => row.id)).toEqual([latest.id]);
    });

    it('marks the latest captured order as the current purchase in detail', async () => {
      const latest = await captured(new Date(now.getTime() - 1000));

      const detail = await service.detail(latest.id, now);

      expect(detail.currentMembership).toMatchObject({
        planCode: 'PLUS',
        isCurrentPurchase: true,
      });
    });

    it('treats a cycle ending exactly now as expired in detail', async () => {
      const ended = await captured(new Date(now.getTime() - 30 * 86_400_000));

      const detail = await service.detail(ended.id, now);

      expect(detail.currentMembership).toEqual({
        planCode: 'FREE',
        startsAt: null,
        expiresAt: null,
        isCurrentPurchase: false,
      });
    });

    it('excludes a suspended customer from the subscriptions list', async () => {
      const suspended = await makeUser({ status: AccountStatus.SUSPENDED });
      await captured(new Date(now.getTime() - 1000), { userId: suspended.id });
      await captured(new Date(now.getTime() - 2000));

      const result = await service.activeSubscriptions(
        new AdminSubscriptionQueryDto(),
        now,
      );

      expect(result.items.map((row) => row.userId)).toEqual([memberId]);
    });
  });

  describe('receipts', () => {
    it('applies the default 30-day window to the receipts list', async () => {
      await models().receipts.create({
        intentId: null,
        outcome: 'PAYMENT_CODE_MISSING',
        providerTransactionId: 'BANK-OLD',
        payloadHash: 'a'.repeat(64),
        createdAt: new Date(Date.now() - 45 * 86_400_000),
      });
      const recent = await models().receipts.create({
        intentId: null,
        outcome: 'PAYMENT_CODE_MISSING',
        providerTransactionId: 'BANK-RECENT',
        payloadHash: 'c'.repeat(64),
        createdAt: new Date(),
      });

      const response = await adminGet('receipts').expect(200);

      const body = response.body as ListBody;
      expect(body.items.map((row) => row.id)).toEqual([recent.id]);
    });

    it('filters receipts by exact outcome', async () => {
      const intent = await seed();
      for (const outcome of ['CAPTURED', 'DUPLICATE', 'DUPLICATE'])
        await models().receipts.create({
          intentId: intent.id,
          outcome,
          providerTransactionId: `BANK-${randomUUID()}`,
          payloadHash: 'b'.repeat(64),
          createdAt: new Date('2026-10-01T05:00:00Z'),
        });

      const response = await adminGet(
        `receipts?from=${range.from}&to=${range.to}&outcome=DUPLICATE`,
      ).expect(200);

      expect((response.body as ListBody).total).toBe(2);
    });
  });
});
