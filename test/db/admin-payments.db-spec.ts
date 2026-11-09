import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { MongoModule } from '../../src/mongo/mongo.module.js';
import { MongoService } from '../../src/mongo/mongo.service.js';
import {
  AccountStatus,
  BillingPlan,
  PaymentIntent,
  PaymentStatus,
  PaymentWebhookReceipt,
  User,
  UserRole,
} from '../../src/mongo/models.js';
import { SubscriptionsModule } from '../../src/subscriptions/subscriptions.module.js';
import { AdminPaymentsController } from '../../src/payments/admin/admin-payments.controller.js';
import { AdminPaymentsService } from '../../src/payments/admin/admin-payments.service.js';
import {
  AdminPaymentListDto,
  AdminPaymentPageDto,
  AdminReceiptQueryDto,
  AdminSubscriptionQueryDto,
} from '../../src/payments/admin/admin-payment-query.dto.js';
import { AppExceptionFilter } from '../../src/common/exceptions/app-exception.filter.js';
import { configureApp } from '../../src/app.setup.js';
import { createUser } from '../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../support/mongo-test-db.js';

describe('Admin payment management with MongoDB', () => {
  let app: INestApplication<App>,
    db: MongoService,
    service: AdminPaymentsService;
  let adminToken: string,
    memberToken: string,
    adminId: string,
    memberId: string;
  const path = '/api/v1/admin/payments';
  const query = { from: '2026-10-01', to: '2026-10-02' };
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
      transferContent: 'PRIVATE_TRANSFER_SNAPSHOT',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      ...extra,
    });
  }
  function receipt(
    intentId: string | null,
    outcome = 'CAPTURED',
    extra: Partial<PaymentWebhookReceipt> = {},
  ) {
    return models().receipts.create({
      intentId,
      outcome,
      providerTransactionId: `BANK-${randomUUID()}`,
      payloadHash: 'a'.repeat(64),
      createdAt: new Date('2026-10-01T00:00:00Z'),
      ...extra,
    });
  }
  function listQuery(extra = {}) {
    return Object.assign(new AdminPaymentListDto(), query, extra);
  }
  async function user(extra: Partial<User> = {}) {
    const id = randomUUID().replaceAll('-', '');
    return createUser(db, {
      username: `pay${id}`,
      email: `${id}@payment.fixture`,
      status: AccountStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      ...extra,
    });
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        MongoModule.forTest(createTestMongoUrl('admin_payments')),
        SubscriptionsModule,
        JwtModule.register({
          global: true,
          secret: 'admin-payments-fixture-secret',
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
    const admin = await user({ role: UserRole.ADMIN }),
      member = await user();
    adminId = admin.id;
    memberId = member.id;
    const jwt = app.get(JwtService);
    adminToken = jwt.sign({ sub: adminId, username: admin.username });
    memberToken = jwt.sign({ sub: memberId, username: member.username });
  });
  beforeEach(async () => {
    await Promise.all([
      models().intents.deleteMany({}),
      models().receipts.deleteMany({}),
      models().users.deleteMany({ _id: { $nin: [adminId, memberId] } }),
    ]);
    await models().users.updateOne(
      { _id: adminId },
      { $set: { role: UserRole.ADMIN, status: AccountStatus.ACTIVE } },
    );
  });
  afterAll(async () => {
    if (app) {
      await dropTestDatabase(app);
      await app.close();
    }
  });

  it('uses capturedAt for revenue and createdAt for the order list', async () => {
    await seed({
      status: PaymentStatus.SUCCEEDED,
      createdAt: new Date('2026-09-01T00:00:00Z'),
      capturedAt: new Date('2026-09-30T17:00:00Z'),
    });
    await seed({
      status: PaymentStatus.SUCCEEDED,
      capturedAt: new Date('2026-10-02T17:00:00Z'),
    });
    await seed({ status: PaymentStatus.CANCELLED, cancelledAt: now });
    const report = await service.overview(query, now);
    expect(report.createdOrders).toEqual({
      total: 2,
      PENDING: 0,
      SUCCEEDED: 1,
      CANCELLED: 1,
    });
    expect(report.captured).toMatchObject({
      count: 1,
      totalVnd: '49000',
      buyers: 1,
    });
    expect((await service.orders(listQuery())).total).toBe(2);
    expect(
      report.daily.find((day) => day.date === '2026-10-01')?.confirmedVnd,
    ).toBe('49000');
  });
  it('sums exact VND above the JavaScript safe integer range', async () => {
    await seed({
      amount: 9007199254740993n,
      status: PaymentStatus.SUCCEEDED,
      capturedAt: now,
    });
    await seed({
      amount: 99000n,
      status: PaymentStatus.SUCCEEDED,
      capturedAt: now,
    });
    const report = await service.overview(query, now);
    expect(report.captured.totalVnd).toBe('9007199254839993');
    expect(report.captured.buyers).toBe(1);
    const orders = await service.orders(listQuery());
    expect(orders.items.some((row) => row.amount === '9007199254740993')).toBe(
      true,
    );
  });
  it('counts confirmed intents once regardless of receipt count and excludes other currencies', async () => {
    const intent = await seed({
      status: PaymentStatus.SUCCEEDED,
      capturedAt: now,
    });
    await receipt(intent.id);
    await receipt(intent.id, 'DUPLICATE');
    await receipt(intent.id);
    await seed({
      status: PaymentStatus.SUCCEEDED,
      currency: 'USD',
      capturedAt: now,
    });
    expect((await service.overview(query, now)).captured).toMatchObject({
      count: 1,
      totalVnd: '49000',
    });
  });
  it('normalizes legacy plans for filters without changing purchased snapshots', async () => {
    const oldPro = await seed({
      planVersion: undefined,
      planCode: BillingPlan.PRO,
      amount: 49000n,
    });
    await seed({
      planVersion: 1,
      planCode: BillingPlan.PREMIUM,
      amount: 99000n,
    });
    await seed({ planVersion: 2, planCode: BillingPlan.PRO, amount: 99000n });
    const plus = await service.orders(listQuery({ plan: 'PLUS' }));
    expect(plus.items).toHaveLength(1);
    expect(plus.items[0]).toMatchObject({
      purchasedPlanName: 'Pro (gói cũ)',
      originalPlanCode: 'PRO',
      planCode: 'PLUS',
      amount: '49000',
    });
    expect((await service.orders(listQuery({ plan: 'PRO' }))).total).toBe(2);
    expect(
      (await models().intents.findById(oldPro.id).exec())?.planVersion,
    ).toBeUndefined();
  });
  it('searches exact invoice/code/transaction and user email/name case-insensitively', async () => {
    const person = await user({
      username: 'exact.member',
      email: 'exact.member@fixture.test',
    });
    const intent = await seed({
      userId: person.id,
      invoiceNumber: 'VED-EXACT',
      paymentCode: 'VEDABC123',
      providerTransactionId: 'BANK-123',
    });
    for (const q of [
      'ved-exact',
      'vedabc123',
      'bank-123',
      'EXACT.MEMBER@FIXTURE.TEST',
      'EXACT.MEMBER',
      intent.id,
      person.id,
      intent.id.toUpperCase(),
      person.id.toUpperCase(),
    ])
      expect((await service.orders(listQuery({ q }))).total).toBe(1);
    for (const q of ['EXACT', '.*', '$where'])
      expect((await service.orders(listQuery({ q }))).total).toBe(0);
  });
  it('applies status, plan and user filters together and paginates deterministically', async () => {
    for (let i = 0; i < 3; i++) await seed();
    await seed({ status: PaymentStatus.CANCELLED, planCode: BillingPlan.PRO });
    const first = await service.orders(
      listQuery({
        status: 'PENDING',
        plan: 'PLUS',
        userId: memberId,
        limit: 2,
      }),
    );
    const second = await service.orders(
      listQuery({
        status: 'PENDING',
        plan: 'PLUS',
        userId: memberId,
        limit: 2,
        page: 2,
      }),
    );
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(first.items.some((row) => row.id === second.items[0].id)).toBe(
      false,
    );
    expect(
      (await service.overview({ ...query, status: PaymentStatus.PENDING }, now))
        .captured.totalVnd,
    ).toBe('0');
  });
  it('derives one current subscription from the latest successful purchase, not the largest tier', async () => {
    await seed({
      planCode: BillingPlan.PRO,
      status: PaymentStatus.SUCCEEDED,
      capturedAt: new Date(now.getTime() - 86400000),
      amount: 99000n,
    });
    const latest = await seed({
      planCode: BillingPlan.PLUS,
      status: PaymentStatus.SUCCEEDED,
      capturedAt: now,
    });
    await seed({ planCode: BillingPlan.PRO, status: PaymentStatus.PENDING });
    const snapshot = (await service.overview(query, now)).membershipSnapshot;
    expect(snapshot).toMatchObject({ PLUS: 1, PRO: 0, total: 1 });
    const active = await service.activeSubscriptions(
      new AdminSubscriptionQueryDto(),
      now,
    );
    expect(active.items[0].id).toBe(latest.id);
  });
  it('does not revive an earlier longer purchase when the latest cycle expires exactly now', async () => {
    await seed({
      status: PaymentStatus.SUCCEEDED,
      capturedAt: new Date(now.getTime() - 2 * 86400000),
      durationDays: 365,
    });
    await seed({
      status: PaymentStatus.SUCCEEDED,
      capturedAt: new Date(now.getTime() - 86400000),
      durationDays: 1,
    });
    expect((await service.overview(query, now)).membershipSnapshot.total).toBe(
      0,
    );
    expect(
      (await service.activeSubscriptions(new AdminSubscriptionQueryDto(), now))
        .total,
    ).toBe(0);
  });
  it('excludes missing, suspended and unverified accounts from the global active snapshot', async () => {
    const suspended = await user({ status: AccountStatus.SUSPENDED }),
      unverified = await user({ emailVerifiedAt: null }),
      active = await user();
    for (const id of [randomUUID(), suspended.id, unverified.id, active.id])
      await seed({
        userId: id,
        status: PaymentStatus.SUCCEEDED,
        capturedAt: now,
      });
    const snapshot = (
      await service.overview(
        { ...query, userId: randomUUID(), plan: BillingPlan.PRO },
        now,
      )
    ).membershipSnapshot;
    expect(snapshot.total).toBe(1);
  });
  it('keeps order history when the customer no longer exists and masks merchant account data', async () => {
    const intent = await seed({
      userId: randomUUID(),
      providerReference: 'REF-1',
    });
    const detail = await service.detail(intent.id, now);
    expect(detail.order.customer).toBeNull();
    expect(detail.merchant.accountLast4).toBe('5678');
    expect(JSON.stringify(detail)).not.toContain('0012345678');
    expect(JSON.stringify(detail)).not.toContain('PRIVATE_TRANSFER_SNAPSHOT');
    expect(JSON.stringify(detail)).not.toContain('passwordHash');
  });
  it('shows current membership separately from the historical purchased cycle', async () => {
    const older = await seed({
      status: PaymentStatus.SUCCEEDED,
      capturedAt: new Date(now.getTime() - 1000),
    });
    await seed({
      planCode: BillingPlan.PRO,
      amount: 99000n,
      status: PaymentStatus.SUCCEEDED,
      capturedAt: now,
    });
    await receipt(older.id, 'CAPTURED');
    await receipt(older.id, 'DUPLICATE');
    const detail = await service.detail(older.id, now);
    expect(detail.order.planCode).toBe('PLUS');
    expect(detail.currentMembership).toMatchObject({
      planCode: 'PRO',
      isCurrentPurchase: false,
    });
    expect(detail.webhookSummary.total).toBe(2);
  });
  it('lists old receipts for an order without the default 30-day filter', async () => {
    const intent = await seed();
    await receipt(intent.id, 'AMOUNT_MISMATCH', {
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const page = await service.orderReceipts(
      intent.id,
      new AdminPaymentPageDto(),
    );
    expect(page.total).toBe(1);
    expect(page.items[0].outcome).toBe('AMOUNT_MISMATCH');
  });
  it('filters unmatched and linked receipts without overwriting intent filters', async () => {
    const intent = await seed();
    await receipt(null, 'PAYMENT_CODE_MISSING', {
      providerTransactionId: 'BANK-UNMATCHED',
    });
    await receipt(intent.id, 'AMOUNT_MISMATCH');
    const filtered = await service.receiptsPage(
      Object.assign(new AdminReceiptQueryDto(), query, {
        unmatched: 'true',
        transactionId: 'BANK-UNMATCHED',
      }),
    );
    expect(filtered.total).toBe(1);
    expect(filtered.items[0].intentId).toBeNull();
    expect(
      (
        await service.receiptsPage(
          Object.assign(new AdminReceiptQueryDto(), query, {
            unmatched: 'true',
            intentId: intent.id,
          }),
        )
      ).total,
    ).toBe(0);
  });
  it('returns not found for missing order and its receipt history', async () => {
    await expect(service.detail(randomUUID())).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      service.orderReceipts(randomUUID(), new AdminPaymentPageDto()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  it('exports exact amounts and safe CSV text without financial mutation', async () => {
    const person = await user({
      username: '=FORMULA',
      email: 'csv@fixture.test',
    });
    const intent = await seed({ userId: person.id, amount: 9007199254740993n });
    const before = (await models().intents.findById(intent.id).lean().exec())!;
    const csv = await service.export(query);
    expect(csv).toContain('"9007199254740993"');
    expect(csv).toContain('"\'=FORMULA"');
    expect(csv).not.toContain('PRIVATE_TRANSFER_SNAPSHOT');
    expect(csv).not.toContain('0012345678');
    await service.detail(intent.id);
    await service.overview(query);
    await service.orders(listQuery());
    expect(
      (await models().intents.findById(intent.id).lean().exec())!.status,
    ).toBe(before.status);
    expect(await models().receipts.countDocuments()).toBe(0);
  });
  it('rejects export above 10000 matching orders instead of truncating silently', async () => {
    const template = (await seed()).toObject();
    await models().intents.deleteMany({});
    await models().intents.insertMany(
      Array.from({ length: 10001 }, (_, i) => ({
        ...template,
        _id: randomUUID(),
        invoiceNumber: `CSV-${i}`,
        paymentCode: `CSV${i}`,
      })),
    );
    await expect(service.export(query)).rejects.toMatchObject({
      statusCode: 400,
    });
  }, 30000);
  it('requires active Admin for every route and rejects a downgraded Admin token', async () => {
    const intent = await seed();
    for (const route of [
      'overview',
      'orders',
      `orders/${intent.id}`,
      `orders/${intent.id}/receipts`,
      'receipts',
      'subscriptions',
      'export',
    ]) {
      await request(app.getHttpServer()).get(`${path}/${route}`).expect(401);
      await request(app.getHttpServer())
        .get(`${path}/${route}`)
        .auth(memberToken, { type: 'bearer' })
        .expect(403);
    }
    await models().users.updateOne(
      { _id: adminId },
      { $set: { role: UserRole.USER } },
    );
    await request(app.getHttpServer())
      .get(`${path}/overview`)
      .auth(adminToken, { type: 'bearer' })
      .expect(403);
  });
  it.each([
    '?from=2026-10-01',
    '?from=2026-02-30&to=2026-03-01',
    '?from=2026-01-01&to=2026-12-31',
    '?status=EXPIRED',
    '?plan=PREMIUM',
    '?userId=invalid',
    '?unexpected=yes',
  ])('validates order filters %s', async (suffix) => {
    await request(app.getHttpServer())
      .get(`${path}/orders${suffix}`)
      .auth(adminToken, { type: 'bearer' })
      .expect(400);
  });
  it('validates pagination and receipt/subscription filters and protects response caches', async () => {
    for (const route of [
      'orders?page=0',
      'orders?limit=101',
      'receipts?unmatched=yes',
      'subscriptions?userId=invalid',
    ])
      await request(app.getHttpServer())
        .get(`${path}/${route}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(400);
    const result = await request(app.getHttpServer())
      .get(`${path}/overview`)
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    const csv = await request(app.getHttpServer())
      .get(`${path}/export`)
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
  });
});
