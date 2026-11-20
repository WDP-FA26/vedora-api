import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InvalidInputException } from '../../../src/common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../../src/common/exceptions/resource-not-found.exception.js';
import {
  AccountStatus,
  BillingPlan,
  PaymentIntent,
  PaymentStatus,
  PaymentWebhookReceipt,
  User,
} from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import {
  AdminPaymentListDto,
  AdminPaymentPageDto,
  AdminPaymentQueryDto,
  AdminReceiptQueryDto,
  AdminSubscriptionQueryDto,
} from '../../../src/payments/admin/admin-payment-query.dto.js';
import { AdminPaymentsService } from '../../../src/payments/admin/admin-payments.service.js';
import { SubscriptionsModule } from '../../../src/subscriptions/subscriptions.module.js';
import { createUser } from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

describe('AdminPaymentsService', () => {
  const NOW = new Date('2026-10-02T10:00:00Z');
  const RANGE = { from: '2026-10-01', to: '2026-10-02' };

  let app: INestApplication;
  let db: MongoService;
  let service: AdminPaymentsService;
  let defaultUser: User;

  const intents = () => db.connection.model<PaymentIntent>(PaymentIntent.name);
  const receipts = () =>
    db.connection.model<PaymentWebhookReceipt>(PaymentWebhookReceipt.name);
  const users = () => db.connection.model<User>(User.name);

  async function makeUser(overrides: Partial<User> = {}) {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    return createUser(db, {
      username: `adm_${suffix}`,
      email: `${suffix}@adminpay.unit`,
      status: AccountStatus.ACTIVE,
      emailVerifiedAt: new Date('2026-09-01T00:00:00Z'),
      ...overrides,
    });
  }

  function seedIntent(overrides: Partial<PaymentIntent> = {}) {
    const id = randomUUID();
    return intents().create({
      _id: id,
      userId: defaultUser.id,
      planCode: BillingPlan.PLUS,
      planVersion: 2,
      textLimit: 300,
      imageLimit: 10,
      durationDays: 30,
      amount: 49000n,
      currency: 'VND',
      status: PaymentStatus.PENDING,
      invoiceNumber: `INV-${id}`,
      paymentCode: `VED${id.slice(0, 6).toUpperCase()}`,
      activeIntentKey: null,
      bankCode: 'VCB',
      bankGateway: 'Vietcombank',
      accountNumber: '0012345678',
      accountHolder: 'VEDORA',
      storeName: 'Vedora',
      transferContent: 'VEDORA',
      providerTransactionId: null,
      providerReference: null,
      paidAt: null,
      capturedAt: null,
      cancelledAt: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      ...overrides,
    });
  }

  function seedReceipt(
    intentId: string | null,
    outcome = 'CAPTURED',
    overrides: Partial<PaymentWebhookReceipt> = {},
  ) {
    return receipts().create({
      _id: randomUUID(),
      intentId,
      outcome,
      providerTransactionId: `BANK-${randomUUID()}`,
      payloadHash: 'a'.repeat(64),
      createdAt: new Date('2026-10-01T00:00:00Z'),
      ...overrides,
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongoModule.forTest(createTestMongoUrl('admin_payments_unit')),
        SubscriptionsModule,
      ],
      providers: [AdminPaymentsService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(AdminPaymentsService);
  });

  beforeEach(async () => {
    await Promise.all([
      intents().deleteMany({}),
      receipts().deleteMany({}),
      users().deleteMany({}),
    ]);
    defaultUser = await makeUser();
  });

  afterAll(async () => {
    if (app) {
      await dropTestDatabase(app);
      await app.close();
    }
  });

  describe('orders', () => {
    it('returns empty page when no orders match', async () => {
      const page = await service.orders(
        Object.assign(new AdminPaymentListDto(), RANGE),
      );
      expect(page).toEqual({
        items: [],
        total: 0,
        page: 1,
        limit: 25,
      });
    });

    it('filters by normalized plan, userId, status, and exact case-insensitive q', async () => {
      const customer = await makeUser({
        username: 'exact.buyer',
        email: 'exact.buyer@vedora.test',
      });
      const legacyPro = await seedIntent({
        userId: customer.id,
        planCode: BillingPlan.PRO,
        planVersion: undefined,
        status: PaymentStatus.SUCCEEDED,
        capturedAt: NOW,
        invoiceNumber: 'VED-INV-EXACT',
        paymentCode: 'VEDEXACT1',
        providerTransactionId: 'BANK-EXACT-1',
      });
      await seedIntent({
        userId: defaultUser.id,
        planCode: BillingPlan.PREMIUM,
        planVersion: 1,
        status: PaymentStatus.CANCELLED,
      });
      await seedIntent({
        userId: defaultUser.id,
        planCode: BillingPlan.PRO,
        planVersion: 2,
        status: PaymentStatus.PENDING,
      });

      const plusOrders = await service.orders(
        Object.assign(new AdminPaymentListDto(), RANGE, {
          plan: BillingPlan.PLUS,
          userId: customer.id.toUpperCase(),
          status: PaymentStatus.SUCCEEDED,
        }),
      );
      expect(plusOrders.total).toBe(1);
      expect(plusOrders.items[0].id).toBe(legacyPro.id);

      const proOrders = await service.orders(
        Object.assign(new AdminPaymentListDto(), RANGE, {
          plan: BillingPlan.PRO,
        }),
      );
      expect(proOrders.total).toBe(2);

      for (const q of [
        legacyPro.id.toUpperCase(),
        customer.id.toUpperCase(),
        'ved-inv-exact',
        'vedexact1',
        'bank-exact-1',
        'EXACT.BUYER',
        'EXACT.BUYER@VEDORA.TEST',
      ]) {
        const res = await service.orders(
          Object.assign(new AdminPaymentListDto(), RANGE, { q: ` ${q} ` }),
        );
        expect(res.total).toBe(1);
      }

      // Regex characters are escaped so partial / wildcard queries do not match
      for (const q of ['exact', '.*', '$where']) {
        const res = await service.orders(
          Object.assign(new AdminPaymentListDto(), RANGE, { q }),
        );
        expect(res.total).toBe(0);
      }
    });

    it('paginates deterministically by createdAt DESC, _id DESC', async () => {
      const sameCreated = new Date('2026-10-01T12:00:00Z');
      await seedIntent({
        _id: '00000000-0000-4000-8000-00000000000a',
        createdAt: sameCreated,
      });
      await seedIntent({
        _id: '00000000-0000-4000-8000-00000000000b',
        createdAt: sameCreated,
      });
      await seedIntent({
        _id: '00000000-0000-4000-8000-00000000000c',
        createdAt: sameCreated,
      });

      const p1 = await service.orders(
        Object.assign(new AdminPaymentListDto(), RANGE, { page: 1, limit: 2 }),
      );
      const p2 = await service.orders(
        Object.assign(new AdminPaymentListDto(), RANGE, { page: 2, limit: 2 }),
      );
      expect(p1.total).toBe(3);
      expect(p1.items.map((r) => r.id)).toEqual([
        '00000000-0000-4000-8000-00000000000c',
        '00000000-0000-4000-8000-00000000000b',
      ]);
      expect(p2.items.map((r) => r.id)).toEqual([
        '00000000-0000-4000-8000-00000000000a',
      ]);
    });
  });

  describe('overview', () => {
    it('returns zeroed metrics and empty arrays on empty database', async () => {
      const report = await service.overview(
        Object.assign(new AdminPaymentQueryDto(), RANGE),
        NOW,
      );
      expect(report).toEqual({
        generatedAt: NOW.toISOString(),
        currency: 'VND',
        range: {
          from: '2026-10-01',
          to: '2026-10-02',
          dayCount: 2,
          timeZone: 'Asia/Bangkok',
        },
        orderDateBasis: 'createdAt',
        revenueDateBasis: 'capturedAt',
        createdOrders: { total: 0, PENDING: 0, SUCCEEDED: 0, CANCELLED: 0 },
        captured: { count: 0, totalVnd: '0', buyers: 0, byPlan: [] },
        daily: [],
        membershipSnapshot: {
          asOf: NOW.toISOString(),
          scope: 'GLOBAL_ACTIVE_VERIFIED_ACCOUNTS',
          PLUS: 0,
          PRO: 0,
          total: 0,
        },
      });
    });

    it('separates createdAt and capturedAt bases, sums BigInt VND via Decimal128, and builds global snapshot', async () => {
      const secondBuyer = await makeUser();
      const suspended = await makeUser({ status: AccountStatus.SUSPENDED });

      // Created before range, captured on 2026-10-01 Bangkok (2026-09-30T17:00Z)
      await seedIntent({
        userId: defaultUser.id,
        planCode: BillingPlan.PLUS,
        amount: 9007199254740993n,
        status: PaymentStatus.SUCCEEDED,
        createdAt: new Date('2026-09-01T00:00:00Z'),
        capturedAt: new Date('2026-09-30T17:00:00Z'),
      });
      // Created on 2026-10-02 Bangkok, captured on 2026-10-02 Bangkok (upgrades defaultUser to PRO)
      await seedIntent({
        userId: defaultUser.id,
        planCode: BillingPlan.PRO,
        amount: 99000n,
        status: PaymentStatus.SUCCEEDED,
        createdAt: new Date('2026-10-02T01:00:00Z'),
        capturedAt: new Date('2026-10-02T02:00:00Z'),
      });
      // Non-VND excluded from captured revenue
      await seedIntent({
        userId: secondBuyer.id,
        currency: 'USD',
        status: PaymentStatus.SUCCEEDED,
        createdAt: new Date('2026-10-01T10:00:00Z'),
        capturedAt: new Date('2026-10-01T10:00:00Z'),
      });
      // Cancelled created in range
      await seedIntent({
        userId: suspended.id,
        status: PaymentStatus.CANCELLED,
        createdAt: new Date('2026-10-01T10:00:00Z'),
        cancelledAt: NOW,
      });
      // Suspended user with active payment excluded from global membershipSnapshot
      await seedIntent({
        userId: suspended.id,
        planCode: BillingPlan.PLUS,
        status: PaymentStatus.SUCCEEDED,
        createdAt: new Date('2026-09-15T00:00:00Z'),
        capturedAt: new Date('2026-09-15T00:00:00Z'),
      });

      const report = await service.overview(
        Object.assign(new AdminPaymentQueryDto(), RANGE),
        NOW,
      );

      expect(report.createdOrders).toEqual({
        total: 3,
        PENDING: 0,
        SUCCEEDED: 2,
        CANCELLED: 1,
      });
      expect(report.captured.count).toBe(2);
      expect(report.captured.totalVnd).toBe('9007199254839993');
      expect(report.captured.buyers).toBe(1);
      expect(report.captured.byPlan).toEqual(
        expect.arrayContaining([
          {
            planCode: BillingPlan.PLUS,
            count: 1,
            totalVnd: '9007199254740993',
            buyers: 1,
          },
          {
            planCode: BillingPlan.PRO,
            count: 1,
            totalVnd: '99000',
            buyers: 1,
          },
        ]),
      );
      expect(report.daily).toEqual([
        {
          date: '2026-10-01',
          createdOrders: 2,
          capturedOrders: 1,
          confirmedVnd: '9007199254740993',
        },
        {
          date: '2026-10-02',
          createdOrders: 1,
          capturedOrders: 1,
          confirmedVnd: '99000',
        },
      ]);
      // Only defaultUser is active + verified; latest cycle is PRO (secondBuyer had USD but still SUCCEEDED PLUS)
      expect(report.membershipSnapshot).toEqual({
        asOf: NOW.toISOString(),
        scope: 'GLOBAL_ACTIVE_VERIFIED_ACCOUNTS',
        PLUS: 1,
        PRO: 1,
        total: 2,
      });
    });
  });

  describe('detail and receipts', () => {
    it('throws NOT_FOUND when detail or orderReceipts order does not exist', async () => {
      await expect(service.detail(randomUUID(), NOW)).rejects.toThrow(
        ResourceNotFoundException,
      );
      await expect(
        service.orderReceipts(randomUUID(), new AdminPaymentPageDto()),
      ).rejects.toThrow(ResourceNotFoundException);
    });

    it('returns detail with FREE membership, masked merchant, null missing customer, and webhook summary', async () => {
      const missingUserOrder = await seedIntent({
        userId: randomUUID(),
        accountNumber: '0012349876',
        status: PaymentStatus.PENDING,
      });
      await seedReceipt(missingUserOrder.id, 'AMOUNT_MISMATCH');
      await seedReceipt(missingUserOrder.id, 'AMOUNT_MISMATCH');
      await seedReceipt(missingUserOrder.id, 'PAYMENT_CANCELLED');

      const detail = await service.detail(
        missingUserOrder.id.toUpperCase(),
        NOW,
      );
      expect(detail.order.customer).toBeNull();
      expect(detail.merchant).toEqual({
        bankCode: 'VCB',
        bankGateway: 'Vietcombank',
        accountLast4: '9876',
      });
      expect(detail.currentMembership).toEqual({
        planCode: 'FREE',
        startsAt: null,
        expiresAt: null,
        isCurrentPurchase: false,
      });
      expect(detail.webhookSummary).toEqual({
        total: 3,
        outcomes: [
          { outcome: 'AMOUNT_MISMATCH', count: 2 },
          { outcome: 'PAYMENT_CANCELLED', count: 1 },
        ],
      });
    });

    it('marks isCurrentPurchase true for active cycle and false when superseded', async () => {
      const older = await seedIntent({
        status: PaymentStatus.SUCCEEDED,
        capturedAt: new Date(NOW.getTime() - 5000),
      });
      const current = await seedIntent({
        planCode: BillingPlan.PRO,
        amount: 99000n,
        status: PaymentStatus.SUCCEEDED,
        capturedAt: NOW,
      });

      expect((await service.detail(current.id, NOW)).currentMembership).toEqual(
        {
          planCode: BillingPlan.PRO,
          startsAt: NOW.toISOString(),
          expiresAt: new Date(NOW.getTime() + 30 * 86_400_000).toISOString(),
          isCurrentPurchase: true,
        },
      );
      expect(
        (await service.detail(older.id, NOW)).currentMembership
          .isCurrentPurchase,
      ).toBe(false);
    });

    it('lists all-time orderReceipts and filters global receiptsPage', async () => {
      const order = await seedIntent();
      await seedReceipt(order.id, 'AMOUNT_MISMATCH', {
        createdAt: new Date('2025-01-01T00:00:00Z'),
      });
      await seedReceipt(order.id, 'CAPTURED', {
        providerTransactionId: 'BANK-MATCHED',
        createdAt: new Date('2026-10-01T02:00:00Z'),
      });
      await seedReceipt(null, 'PAYMENT_CODE_MISSING', {
        providerTransactionId: 'BANK-UNMATCHED',
        createdAt: new Date('2026-10-01T03:00:00Z'),
      });

      const allOrderReceipts = await service.orderReceipts(
        order.id.toUpperCase(),
        Object.assign(new AdminPaymentPageDto(), { page: 1, limit: 1 }),
      );
      expect(allOrderReceipts.total).toBe(2);
      expect(allOrderReceipts.items).toHaveLength(1);
      expect(allOrderReceipts.items[0].outcome).toBe('CAPTURED');

      const matchedOnly = await service.receiptsPage(
        Object.assign(new AdminReceiptQueryDto(), RANGE, {
          intentId: order.id.toUpperCase(),
          outcome: 'CAPTURED',
          transactionId: 'BANK-MATCHED',
          unmatched: 'false',
        }),
      );
      expect(matchedOnly.total).toBe(1);

      const unmatchedOnly = await service.receiptsPage(
        Object.assign(new AdminReceiptQueryDto(), RANGE, {
          unmatched: 'true',
        }),
      );
      expect(unmatchedOnly.total).toBe(1);
      expect(unmatchedOnly.items[0].intentId).toBeNull();

      // Contradictory AND filters return 0 rather than overwriting each other
      const contradictory = await service.receiptsPage(
        Object.assign(new AdminReceiptQueryDto(), RANGE, {
          unmatched: 'true',
          intentId: order.id,
        }),
      );
      expect(contradictory.total).toBe(0);
    });
  });

  describe('activeSubscriptions and export', () => {
    it('filters activeSubscriptions by plan and userId and excludes expired/unverified accounts', async () => {
      const proUser = await makeUser();
      const unverified = await makeUser({ emailVerifiedAt: null });

      await seedIntent({
        userId: defaultUser.id,
        planCode: BillingPlan.PLUS,
        status: PaymentStatus.SUCCEEDED,
        capturedAt: NOW,
      });
      const proOrder = await seedIntent({
        userId: proUser.id,
        planCode: BillingPlan.PRO,
        amount: 99000n,
        status: PaymentStatus.SUCCEEDED,
        capturedAt: NOW,
      });
      await seedIntent({
        userId: unverified.id,
        planCode: BillingPlan.PRO,
        status: PaymentStatus.SUCCEEDED,
        capturedAt: NOW,
      });

      const filtered = await service.activeSubscriptions(
        Object.assign(new AdminSubscriptionQueryDto(), {
          plan: BillingPlan.PRO,
          userId: proUser.id.toUpperCase(),
          page: 1,
          limit: 10,
        }),
        NOW,
      );
      expect(filtered.asOf).toBe(NOW.toISOString());
      expect(filtered.total).toBe(1);
      expect(filtered.items[0].id).toBe(proOrder.id);

      const all = await service.activeSubscriptions(
        new AdminSubscriptionQueryDto(),
        NOW,
      );
      expect(all.total).toBe(2);
    });

    it('exports UTF-8 BOM CSV with formula escaping and missing customer handling, and rejects >10000 rows', async () => {
      const formulaUser = await makeUser({
        username: '=cmd()',
        email: '+plus@test.local',
      });
      await seedIntent({
        userId: formulaUser.id,
        amount: 9007199254740993n,
      });
      await seedIntent({
        userId: randomUUID(),
        amount: 49000n,
      });

      const csv = await service.export(
        Object.assign(new AdminPaymentQueryDto(), RANGE),
      );
      expect(csv.startsWith('\ufeff"id","userId"')).toBe(true);
      expect(csv).toContain('\r\n');
      expect(csv).toContain('"\'=cmd()"');
      expect(csv).toContain('"\'+plus@test.local"');
      expect(csv).toContain('"9007199254740993"');
      expect(csv).toContain('""');

      const template = (await intents().findOne({}).lean().exec())!;
      await intents().deleteMany({});
      await intents().insertMany(
        Array.from({ length: 10001 }, (_, i) => ({
          ...template,
          _id: randomUUID(),
          invoiceNumber: `EXP-${i}`,
          paymentCode: `EXP${i}`,
        })),
      );
      await expect(
        service.export(Object.assign(new AdminPaymentQueryDto(), RANGE)),
      ).rejects.toThrow(InvalidInputException);
    }, 30000);
  });
});
