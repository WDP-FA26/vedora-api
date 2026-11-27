import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  BillingPlan,
  PaymentIntent,
  PaymentStatus,
} from '@src/mongo/models.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import { SubscriptionsModule } from '@src/subscriptions/subscriptions.module.js';
import { SubscriptionsService } from '@src/subscriptions/subscriptions.service.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';

const USER_ID = '00000000-0000-4000-8000-000000000101';
const NOW = new Date('2026-11-09T10:00:00Z');

describe('SubscriptionsService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: SubscriptionsService;

  const intents = () => db.connection.model<PaymentIntent>(PaymentIntent.name);

  async function seedIntent(overrides: Partial<PaymentIntent> = {}) {
    const id = randomUUID();
    return intents().create({
      _id: id,
      userId: USER_ID,
      planCode: BillingPlan.PLUS,
      planVersion: 2,
      textLimit: 300,
      imageLimit: 10,
      durationDays: 30,
      amount: 49000n,
      currency: 'VND',
      status: PaymentStatus.SUCCEEDED,
      invoiceNumber: `INV-${id}`,
      paymentCode: `VED${id.slice(0, 6).toUpperCase()}`,
      activeIntentKey: null,
      providerTransactionId: `BANK-${id}`,
      capturedAt: new Date(NOW.getTime() - 86_400_000),
      paidAt: new Date(NOW.getTime() - 86_400_000),
      bankCode: 'VCB',
      bankGateway: 'Vietcombank',
      accountNumber: '0012345678',
      accountHolder: 'FIXTURE',
      storeName: 'FIXTURE',
      transferContent: 'FIXTURE',
      ...overrides,
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongoModule.forTest(createTestMongoUrl('subscriptions_unit')),
        SubscriptionsModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(SubscriptionsService);
  });

  beforeEach(async () => {
    await intents().deleteMany({});
  });

  afterAll(async () => {
    if (app) {
      await dropTestDatabase(app);
      await app.close();
    }
  });

  it('returns the Bangkok-day FREE period when the user has no succeeded intents', async () => {
    await seedIntent({
      status: PaymentStatus.PENDING,
      activeIntentKey: USER_ID,
    });
    await seedIntent({ status: PaymentStatus.CANCELLED });

    expect(await service.period(USER_ID, NOW)).toEqual({
      planCode: 'FREE',
      key: 'free:2026-11-09',
      startsAt: new Date('2026-11-08T17:00:00.000Z'),
      expiresAt: new Date('2026-11-09T17:00:00.000Z'),
      textLimit: 5,
      imageLimit: 0,
    });
  });

  it('returns FREE when latest succeeded intent has null capturedAt or expired exactly at now', async () => {
    await seedIntent({ capturedAt: null, providerTransactionId: null });
    expect((await service.period(USER_ID, NOW)).planCode).toBe('FREE');

    await intents().deleteMany({});
    await seedIntent({
      capturedAt: new Date(NOW.getTime() - 30 * 86_400_000),
      durationDays: 30,
    });
    expect((await service.period(USER_ID, NOW)).planCode).toBe('FREE');
  });

  it('returns active v2 paid cycle using snapshot limits', async () => {
    const capturedAt = new Date(NOW.getTime() - 1000);
    const payment = await seedIntent({
      planCode: BillingPlan.PRO,
      planVersion: 2,
      textLimit: 950,
      imageLimit: 45,
      durationDays: 30,
      capturedAt,
    });

    expect(await service.period(USER_ID, NOW)).toEqual({
      planCode: BillingPlan.PRO,
      key: `payment:${payment.id}`,
      startsAt: capturedAt,
      expiresAt: new Date(capturedAt.getTime() + 30 * 86_400_000),
      textLimit: 950,
      imageLimit: 45,
    });
  });

  it('falls back to policy limits for legacy v1 intents without snapshot limits', async () => {
    const legacyPro = await seedIntent({
      planCode: BillingPlan.PRO,
      planVersion: undefined,
      textLimit: undefined,
      imageLimit: undefined,
      capturedAt: new Date(NOW.getTime() - 2000),
    });
    expect(await service.period(USER_ID, NOW)).toMatchObject({
      planCode: BillingPlan.PLUS,
      key: `payment:${legacyPro.id}`,
      textLimit: 300,
      imageLimit: 10,
    });

    await intents().deleteMany({});
    const legacyPremium = await seedIntent({
      planCode: BillingPlan.PREMIUM,
      planVersion: 1,
      textLimit: undefined,
      imageLimit: undefined,
      capturedAt: new Date(NOW.getTime() - 1000),
    });
    expect(await service.period(USER_ID, NOW)).toMatchObject({
      planCode: BillingPlan.PRO,
      key: `payment:${legacyPremium.id}`,
      textLimit: 900,
      imageLimit: 40,
    });
  });

  it('selects latest capturedAt with _id descending tiebreaker and supports sessions', async () => {
    const sameTime = new Date(NOW.getTime() - 5000);
    await seedIntent({
      _id: '00000000-0000-4000-8000-00000000000a',
      planCode: BillingPlan.PLUS,
      capturedAt: sameTime,
    });
    const winner = await seedIntent({
      _id: '00000000-0000-4000-8000-00000000000z',
      planCode: BillingPlan.PRO,
      textLimit: 900,
      imageLimit: 40,
      capturedAt: sameTime,
    });

    const period = await db.withTransaction((session) =>
      service.period(USER_ID, NOW, session),
    );
    expect(period.planCode).toBe(BillingPlan.PRO);
    expect(period.key).toBe(`payment:${winner.id}`);

    expect((await service.period(USER_ID)).planCode).toBe(BillingPlan.PRO);
    await intents().deleteMany({});
    expect((await service.period(USER_ID)).planCode).toBe('FREE');
  });
});
