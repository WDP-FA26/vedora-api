import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mongo } from 'mongoose';
import { InvalidInputException } from '../../../src/common/exceptions/invalid-input.exception.js';
import { StateConflictException } from '../../../src/common/exceptions/state-conflict.exception.js';
import {
  AccountStatus,
  AiFeature,
  AiRequest,
  BillingPlan,
  PaymentIntent,
  PaymentStatus,
  User,
  UserRole,
} from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import {
  AiUsageService,
  usageHash,
  type UsageTicket,
} from '../../../src/subscriptions/ai-usage.service.js';
import { SubscriptionsModule } from '../../../src/subscriptions/subscriptions.module.js';
import { SubscriptionsService } from '../../../src/subscriptions/subscriptions.service.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

const USER_ID = '00000000-0000-4000-8000-000000000202';
const NOW = new Date('2026-11-09T10:00:00Z');

describe('AiUsageService', () => {
  let app: INestApplication;
  let db: MongoService;
  let usage: AiUsageService;
  let subscriptions: SubscriptionsService;

  const requests = () => db.connection.model<AiRequest>(AiRequest.name);
  const intents = () => db.connection.model<PaymentIntent>(PaymentIntent.name);
  const users = () => db.connection.model<User>(User.name);

  async function seedPaid(
    plan: BillingPlan = BillingPlan.PLUS,
    capturedAt = new Date(NOW.getTime() - 86_400_000),
  ) {
    const id = randomUUID();
    return intents().create({
      _id: id,
      userId: USER_ID,
      planCode: plan,
      planVersion: 2,
      textLimit: plan === BillingPlan.PLUS ? 300 : 900,
      imageLimit: plan === BillingPlan.PLUS ? 10 : 40,
      durationDays: 30,
      amount: BigInt(plan === BillingPlan.PLUS ? 49000 : 99000),
      currency: 'VND',
      status: PaymentStatus.SUCCEEDED,
      invoiceNumber: `INV-${id}`,
      paymentCode: `VED${id.slice(0, 6).toUpperCase()}`,
      activeIntentKey: null,
      providerTransactionId: `BANK-${id}`,
      capturedAt,
      paidAt: capturedAt,
      bankCode: 'VCB',
      bankGateway: 'Vietcombank',
      accountNumber: '0012345678',
      accountHolder: 'FIXTURE',
      storeName: 'FIXTURE',
      transferContent: 'FIXTURE',
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongoModule.forTest(createTestMongoUrl('ai_usage_unit')),
        SubscriptionsModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    usage = app.get(AiUsageService);
    subscriptions = app.get(SubscriptionsService);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await requests().deleteMany({});
    await intents().deleteMany({});
    await users().deleteMany({});
  });

  afterAll(async () => {
    if (app) {
      await dropTestDatabase(app);
      await app.close();
    }
  });

  it('produces deterministic SHA-256 hashes via usageHash', () => {
    const first = usageHash({ prompt: 'tofu', step: 1 });
    const second = usageHash({ prompt: 'tofu', step: 1 });
    const different = usageHash({ prompt: 'tempeh', step: 1 });

    expect(first).toHaveLength(64);
    expect(first).toBe(second);
    expect(first).not.toBe(different);
  });

  it('rejects empty or over-200-char requestId values and accepts boundary lengths', async () => {
    await expect(
      usage.consume(USER_ID, AiFeature.BLOG_CHAT, { requestId: '' }, NOW),
    ).rejects.toThrow(InvalidInputException);

    await expect(
      usage.consume(
        USER_ID,
        AiFeature.BLOG_CHAT,
        { requestId: 'a'.repeat(201) },
        NOW,
      ),
    ).rejects.toThrow(InvalidInputException);

    const minTicket = await usage.consume(
      USER_ID,
      AiFeature.BLOG_CHAT,
      { requestId: 'a' },
      NOW,
    );
    const maxTicket = await usage.consume(
      USER_ID,
      AiFeature.BLOG_CHAT,
      { requestId: 'b'.repeat(200) },
      NOW,
    );
    expect(minTicket).not.toBeNull();
    expect(maxTicket).not.toBeNull();
  });

  it('shares FREE text bucket across chat features, denies FREE images, and clamps remaining at 0', async () => {
    const t1 = await usage.consume(USER_ID, AiFeature.MEAL_PLAN_CHAT, {}, NOW);
    const t2 = await usage.consume(USER_ID, AiFeature.BLOG_CHAT, {}, NOW);
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    await usage.complete(t1!);

    const freeSummary = await usage.summary(
      USER_ID,
      AiFeature.MEAL_PLAN_CHAT,
      NOW,
    );
    expect(freeSummary).toEqual({
      feature: AiFeature.MEAL_PLAN_CHAT,
      used: 2,
      limit: 5,
      remaining: 3,
      resetsAt: new Date('2026-11-09T17:00:00.000Z'),
      period: 'DAY',
    });

    expect(
      await usage.consume(USER_ID, AiFeature.BLOG_IMAGE, {}, NOW),
    ).toBeNull();
    expect(
      await usage.summary(USER_ID, AiFeature.BLOG_IMAGE, NOW),
    ).toMatchObject({
      used: 0,
      limit: 0,
      remaining: 0,
      period: 'DAY',
    });

    // If usage exceeds limit (e.g. legacy/overcount), remaining clamps at 0
    const period = await subscriptions.period(USER_ID, NOW);
    await requests().insertMany(
      Array.from({ length: 5 }, () => ({
        userId: USER_ID,
        feature: AiFeature.BLOG_CHAT,
        requestKey: randomUUID(),
        periodKey: period.key,
        bucket: 'TEXT',
        promptHash: 'fixture',
        charged: true,
        status: 'COMPLETED',
      })),
    );
    expect(
      await usage.summary(USER_ID, AiFeature.BLOG_CHAT, NOW),
    ).toMatchObject({
      used: 7,
      limit: 5,
      remaining: 0,
    });
    expect(
      await usage.consume(USER_ID, AiFeature.BLOG_CHAT, {}, NOW),
    ).toBeNull();
  });

  it('handles paid CYCLE summaries, independent image quota, and default now/context', async () => {
    await seedPaid(BillingPlan.PLUS);

    const textTicket = await usage.consume(USER_ID, AiFeature.BLOG_CHAT);
    const imageTicket = await usage.consume(USER_ID, AiFeature.BLOG_IMAGE);
    expect(textTicket).not.toBeNull();
    expect(imageTicket).not.toBeNull();
    await usage.complete(textTicket!);
    await usage.complete(imageTicket!);

    expect(await usage.summary(USER_ID, AiFeature.BLOG_CHAT)).toMatchObject({
      used: 1,
      limit: 300,
      remaining: 299,
      period: 'CYCLE',
    });
    expect(await usage.summary(USER_ID, AiFeature.BLOG_IMAGE)).toMatchObject({
      used: 1,
      limit: 10,
      remaining: 9,
      period: 'CYCLE',
    });
  });

  it('enforces idempotency conflicts, in-progress leases, and already-processed errors', async () => {
    const requestId = randomUUID();
    const ticket = (await usage.consume(
      USER_ID,
      AiFeature.BLOG_CHAT,
      { requestId, prompt: 'menu', input: 'step-0' },
      NOW,
    )) as UsageTicket;

    await expect(
      usage.consume(
        USER_ID,
        AiFeature.BLOG_CHAT,
        { requestId, prompt: 'different', input: 'step-0' },
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });

    await expect(
      usage.consume(
        USER_ID,
        AiFeature.BLOG_CHAT,
        { requestId, prompt: 'menu', input: 'step-0' },
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'AI_REQUEST_IN_PROGRESS',
    });

    await usage.complete(ticket);

    await expect(
      usage.consume(
        USER_ID,
        AiFeature.BLOG_CHAT,
        { requestId, prompt: 'menu', input: 'step-0' },
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'AI_REQUEST_ALREADY_PROCESSED',
    });

    // Completed request without continuation: true -> AI_REQUEST_EXPIRED
    await expect(
      usage.consume(
        USER_ID,
        AiFeature.BLOG_CHAT,
        { requestId, prompt: 'menu', input: 'step-1', continuation: false },
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'AI_REQUEST_EXPIRED',
    });
  });

  it('recovers after lease expiration by pruning activeHash and allowing retry', async () => {
    const requestId = randomUUID();
    const first = (await usage.consume(
      USER_ID,
      AiFeature.MEAL_PLAN_CHAT,
      { requestId, prompt: 'plan', input: 'initial' },
      NOW,
    )) as UsageTicket;

    const afterLease = new Date(NOW.getTime() + 10 * 60_000 + 1);
    expect(
      (await usage.summary(USER_ID, AiFeature.MEAL_PLAN_CHAT, afterLease)).used,
    ).toBe(0);

    const retried = (await usage.consume(
      USER_ID,
      AiFeature.MEAL_PLAN_CHAT,
      { requestId, prompt: 'plan', input: 'initial' },
      afterLease,
    )) as UsageTicket;
    expect(retried.id).toBe(first.id);
    expect(retried.token).not.toBe(first.token);

    // Stale ticket cannot complete or refund the active retry
    await usage.complete(first);
    await usage.refund(first);
    const stored = await requests().findById(first.id).exec();
    expect(stored?.status).toBe('RESERVED');

    await usage.complete(retried);
    expect(
      (await usage.summary(USER_ID, AiFeature.MEAL_PLAN_CHAT, afterLease)).used,
    ).toBe(1);
  });

  it('supports bounded continuations up to 8 hashes and rejects orphan/cross-period continuations', async () => {
    // Orphan continuation
    await expect(
      usage.consume(
        USER_ID,
        AiFeature.BLOG_CHAT,
        {
          requestId: randomUUID(),
          prompt: 'p',
          input: 'step',
          continuation: true,
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'AI_REQUEST_EXPIRED' });

    const requestId = randomUUID();
    const initial = (await usage.consume(
      USER_ID,
      AiFeature.BLOG_CHAT,
      { requestId, prompt: 'p', input: 'step-0' },
      NOW,
    )) as UsageTicket;
    await usage.complete(initial);

    // Fill remaining 4 free turns so quota is full (5/5), yet continuations still pass
    for (let i = 0; i < 4; i++) {
      const t = (await usage.consume(
        USER_ID,
        AiFeature.BLOG_CHAT,
        { requestId: randomUUID(), prompt: 'other', input: 'other' },
        NOW,
      )) as UsageTicket;
      await usage.complete(t);
    }

    for (let step = 1; step < 8; step++) {
      const cont = (await usage.consume(
        USER_ID,
        AiFeature.BLOG_CHAT,
        {
          requestId,
          prompt: 'p',
          input: `step-${step}`,
          continuation: true,
        },
        NOW,
      )) as UsageTicket;
      await usage.complete(cont);
    }

    // 9th hash exceeds MAX_REQUESTS_PER_TURN (8)
    await expect(
      usage.consume(
        USER_ID,
        AiFeature.BLOG_CHAT,
        {
          requestId,
          prompt: 'p',
          input: 'step-8',
          continuation: true,
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'AI_REQUEST_EXPIRED' });

    // Cross-period continuation (e.g. user upgrades cycle) is rejected
    await seedPaid(BillingPlan.PLUS, new Date(NOW.getTime() - 5000));
    const cycleReq = randomUUID();
    const cycleTicket = (await usage.consume(
      USER_ID,
      AiFeature.BLOG_CHAT,
      { requestId: cycleReq, prompt: 'cycle', input: 'c0' },
      NOW,
    )) as UsageTicket;
    await usage.complete(cycleTicket);

    await seedPaid(BillingPlan.PRO, new Date(NOW.getTime() + 1000));
    await expect(
      usage.consume(
        USER_ID,
        AiFeature.BLOG_CHAT,
        {
          requestId: cycleReq,
          prompt: 'cycle',
          input: 'c1',
          continuation: true,
        },
        new Date(NOW.getTime() + 2000),
      ),
    ).rejects.toMatchObject({ code: 'AI_REQUEST_EXPIRED' });
  });

  it('refunds reserved tickets, pulls hash, and allows retry', async () => {
    const requestId = randomUUID();
    const first = (await usage.consume(
      USER_ID,
      AiFeature.BLOG_CHAT,
      { requestId, prompt: 'retry', input: 'same-input' },
      NOW,
    )) as UsageTicket;

    await usage.refund(first);
    expect((await usage.summary(USER_ID, AiFeature.BLOG_CHAT, NOW)).used).toBe(
      0,
    );

    const retried = (await usage.consume(
      USER_ID,
      AiFeature.BLOG_CHAT,
      { requestId, prompt: 'retry', input: 'same-input' },
      NOW,
    )) as UsageTicket;
    expect(retried.id).toBe(first.id);
    await usage.complete(retried);
    expect((await usage.summary(USER_ID, AiFeature.BLOG_CHAT, NOW)).used).toBe(
      1,
    );
  });

  it('retries unique violations up to 5 times and throws CONFLICT on exhaustion, while rethrowing non-unique errors', async () => {
    const duplicateError = Object.assign(
      new mongo.MongoServerError({ message: 'E11000 duplicate key' }),
      { code: 11000 },
    );
    const txSpy = vi
      .spyOn(db, 'withTransaction')
      .mockRejectedValue(duplicateError);

    await expect(
      usage.consume(
        USER_ID,
        AiFeature.BLOG_CHAT,
        { requestId: 'dup-test' },
        NOW,
      ),
    ).rejects.toThrow(StateConflictException);
    expect(txSpy).toHaveBeenCalledTimes(5);

    txSpy.mockReset();
    txSpy.mockRejectedValueOnce(new Error('unexpected db failure'));
    await expect(
      usage.consume(
        USER_ID,
        AiFeature.BLOG_CHAT,
        { requestId: 'err-test' },
        NOW,
      ),
    ).rejects.toThrow('unexpected db failure');
    expect(txSpy).toHaveBeenCalledTimes(1);
  });

  it('allows unlimited AI text and image usage for ADMIN users on FREE plan', async () => {
    const adminId = randomUUID();
    await users().create({
      _id: adminId,
      username: 'ai.admin',
      fullName: 'AI Admin',
      email: 'ai.admin@vedora.local',
      role: UserRole.ADMIN,
      status: AccountStatus.ACTIVE,
    });

    for (let i = 0; i < 6; i++) {
      const ticket = await usage.consume(
        adminId,
        AiFeature.MEAL_PLAN_CHAT,
        {},
        NOW,
      );
      expect(ticket).not.toBeNull();
      await usage.complete(ticket as UsageTicket);
    }

    const imageTicket = await usage.consume(
      adminId,
      AiFeature.BLOG_IMAGE,
      {},
      NOW,
    );
    expect(imageTicket).not.toBeNull();
    await usage.complete(imageTicket as UsageTicket);
  });
});
