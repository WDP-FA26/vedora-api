import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MongoModule } from '../../src/mongo/mongo.module.js';
import { MongoService } from '../../src/mongo/mongo.service.js';
import {
  AiFeature,
  AiRequest,
  BillingPlan,
  PaymentIntent,
  PaymentStatus,
} from '../../src/mongo/models.js';
import { SubscriptionsModule } from '../../src/subscriptions/subscriptions.module.js';
import { SubscriptionsService } from '../../src/subscriptions/subscriptions.service.js';
import {
  AiUsageService,
  type UsageTicket,
} from '../../src/subscriptions/ai-usage.service.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../support/mongo-test-db.js';

const USER = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const NOW = new Date('2026-11-09T10:00:00Z');
describe('subscription cycles and shared AI allowance with MongoDB', () => {
  let app: INestApplication,
    db: MongoService,
    usage: AiUsageService,
    subscriptions: SubscriptionsService;
  const requests = () => db.connection.model<AiRequest>(AiRequest.name);
  const intents = () => db.connection.model<PaymentIntent>(PaymentIntent.name);
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        MongoModule.forTest(createTestMongoUrl('subscription')),
        SubscriptionsModule,
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    usage = app.get(AiUsageService);
    subscriptions = app.get(SubscriptionsService);
  });
  beforeEach(async () => {
    await requests().deleteMany({});
    await intents().deleteMany({});
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });
  const take = (
    feature = AiFeature.BLOG_CHAT,
    requestId = randomUUID(),
    now = NOW,
    input = 'hello',
    continuation = false,
  ) =>
    usage.consume(
      USER,
      feature,
      { requestId, prompt: 'hello', input, continuation },
      now,
    );
  const summary = (feature = AiFeature.BLOG_CHAT, now = NOW) =>
    usage.summary(USER, feature, now);
  const paid = async (
    plan = BillingPlan.PLUS,
    version: number | undefined = 2,
    capturedAt = new Date(NOW.getTime() - 86400000),
  ) =>
    intents().create({
      userId: USER,
      planCode: plan,
      planVersion: version,
      durationDays: 30,
      amount: BigInt(plan === BillingPlan.PLUS ? 49000 : 99000),
      currency: 'VND',
      status: PaymentStatus.SUCCEEDED,
      invoiceNumber: randomUUID(),
      paymentCode: randomUUID(),
      providerTransactionId: randomUUID(),
      capturedAt,
      paidAt: capturedAt,
      activeIntentKey: null,
      bankCode: 'VCB',
      bankGateway: 'Vietcombank',
      accountNumber: '0012345678',
      accountHolder: 'FIXTURE',
      storeName: 'FIXTURE',
      transferContent: 'FIXTURE',
    });
  const fill = async (count: number, feature = AiFeature.BLOG_CHAT) => {
    const period = await subscriptions.period(USER, NOW);
    await requests().insertMany(
      Array.from({ length: count }, () => ({
        userId: USER,
        feature,
        requestKey: randomUUID(),
        periodKey: period.key,
        bucket: feature === AiFeature.BLOG_IMAGE ? 'IMAGE' : 'TEXT',
        promptHash: 'fixture',
        charged: true,
        status: 'COMPLETED',
      })),
    );
  };

  it('shares the free allowance across planner and blog, and denies free image generation', async () => {
    for (let i = 0; i < 5; i++)
      expect(
        await take(i % 2 ? AiFeature.MEAL_PLAN_CHAT : AiFeature.BLOG_CHAT),
      ).not.toBeNull();
    expect(await take()).toBeNull();
    expect(await take(AiFeature.BLOG_IMAGE)).toBeNull();
    expect(await summary(AiFeature.MEAL_PLAN_CHAT)).toMatchObject({
      used: 5,
      limit: 5,
      remaining: 0,
      period: 'DAY',
      resetsAt: new Date('2026-11-09T17:00:00Z'),
    });
  });
  it('never over-allocates the last slot under concurrent requests', async () => {
    const tickets = await Promise.all(Array.from({ length: 12 }, () => take()));
    expect(tickets.filter(Boolean)).toHaveLength(5);
    expect((await summary()).used).toBe(5);
  });
  it('provides Plus cycle limits and keeps images separate from text', async () => {
    const payment = await paid();
    await fill(299);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => take(AiFeature.MEAL_PLAN_CHAT)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await summary()).toMatchObject({
      used: 300,
      limit: 300,
      remaining: 0,
      period: 'CYCLE',
      resetsAt: new Date(payment.capturedAt!.getTime() + 30 * 86400000),
    });
    expect(await take(AiFeature.BLOG_IMAGE)).not.toBeNull();
    expect(await summary(AiFeature.BLOG_IMAGE)).toMatchObject({
      used: 1,
      limit: 10,
    });
  });
  it.each([
    { plan: BillingPlan.PLUS, limit: 10 },
    { plan: BillingPlan.PRO, limit: 40 },
  ])('enforces the image cap independently: $plan', async ({ plan, limit }) => {
    await paid(plan);
    await fill(limit, AiFeature.BLOG_IMAGE);
    expect(await take(AiFeature.BLOG_IMAGE)).toBeNull();
    expect(await summary(AiFeature.BLOG_IMAGE)).toMatchObject({
      used: limit,
      limit,
      remaining: 0,
    });
    expect((await summary()).used).toBe(0);
  });

  it('starts Pro immediately with a new expiry and fresh quota, without carrying Plus usage', async () => {
    await paid();
    await fill(300);
    const captured = NOW;
    await paid(BillingPlan.PRO, 2, captured);
    expect(await subscriptions.period(USER, NOW)).toMatchObject({
      planCode: 'PRO',
      startsAt: captured,
      expiresAt: new Date(captured.getTime() + 30 * 86400000),
    });
    expect(await summary()).toMatchObject({ used: 0, limit: 900 });
    expect(await summary(AiFeature.BLOG_IMAGE)).toMatchObject({
      used: 0,
      limit: 40,
    });
    expect(await take()).not.toBeNull();
  });
  it('maps legacy prices to the correct current entitlement without rewriting records', async () => {
    const payment = await paid(BillingPlan.PRO, 1);
    await intents().updateOne(
      { _id: payment.id },
      { $unset: { planVersion: 1 } },
    );
    expect((await subscriptions.period(USER, NOW)).planCode).toBe('PLUS');
    expect((await intents().findById(payment.id).exec())!.planCode).toBe('PRO');
    await intents().deleteMany({});
    await paid(BillingPlan.PREMIUM, 1);
    expect((await subscriptions.period(USER, NOW)).planCode).toBe('PRO');
  });
  it('honors captured allowance snapshots instead of changing an active purchased contract', async () => {
    const payment = await paid();
    await intents().updateOne(
      { _id: payment.id },
      { $set: { textLimit: 17, imageLimit: 2 } },
    );
    expect(await summary()).toMatchObject({ limit: 17 });
    expect(await summary(AiFeature.BLOG_IMAGE)).toMatchObject({ limit: 2 });
  });

  it('returns to Free exactly at expiry and starts its daily bucket independently', async () => {
    await paid(BillingPlan.PRO, 2, new Date(NOW.getTime() - 30 * 86400000));
    expect((await subscriptions.period(USER, NOW)).planCode).toBe('FREE');
    expect(await summary()).toMatchObject({ used: 0, limit: 5, period: 'DAY' });
  });
  it('refunds by ticket so a late failure never refunds a new cycle', async () => {
    const old = (await take()) as UsageTicket;
    await paid(BillingPlan.PRO, 2, NOW);
    const current = (await take()) as UsageTicket;
    await usage.complete(current);
    await usage.refund(old);
    await usage.refund(old);
    expect(await summary()).toMatchObject({ used: 1, remaining: 899 });
  });
  it('deduplicates concurrent retries and rejects changed prompts or completed replays', async () => {
    const id = randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => take(AiFeature.BLOG_CHAT, id)),
    );
    const accepted = results.filter((result) => result.status === 'fulfilled');
    expect(accepted).toHaveLength(1);
    const ticket = (accepted[0] as PromiseFulfilledResult<UsageTicket>).value;
    await usage.complete(ticket);
    await expect(take(AiFeature.BLOG_CHAT, id)).rejects.toMatchObject({
      code: 'AI_REQUEST_ALREADY_PROCESSED',
    });
    await expect(
      usage.consume(
        USER,
        AiFeature.BLOG_CHAT,
        { requestId: id, prompt: 'changed', input: 'changed' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await summary()).used).toBe(1);
  });
  it('permits bounded editor continuations without charging another text turn', async () => {
    const id = randomUUID(),
      ticket = (await take(AiFeature.BLOG_CHAT, id)) as UsageTicket;
    await usage.complete(ticket);
    for (let step = 1; step < 8; step++) {
      const next = (await take(
        AiFeature.BLOG_CHAT,
        id,
        NOW,
        `tool output ${step}`,
        true,
      )) as UsageTicket;
      await usage.complete(next);
    }
    expect((await summary(AiFeature.MEAL_PLAN_CHAT)).used).toBe(1);
    await expect(
      take(AiFeature.BLOG_CHAT, id, NOW, 'extra', true),
    ).rejects.toMatchObject({ code: 'AI_REQUEST_EXPIRED' });
    await expect(
      take(AiFeature.BLOG_CHAT, randomUUID(), NOW, 'orphan', true),
    ).rejects.toMatchObject({ code: 'AI_REQUEST_EXPIRED' });
  });
  it('releases a failed reservation, permits retry, and ignores stale completion tokens', async () => {
    const id = randomUUID(),
      old = (await take(AiFeature.BLOG_CHAT, id)) as UsageTicket;
    await usage.refund(old);
    const retry = (await take(AiFeature.BLOG_CHAT, id)) as UsageTicket;
    await usage.complete(old);
    await usage.refund(old);
    await usage.refund(retry);
    expect((await summary()).used).toBe(0);
  });
  it('does not strand quota after a worker crashes or after Bangkok midnight', async () => {
    const id = randomUUID(),
      old = (await take(AiFeature.BLOG_CHAT, id)) as UsageTicket;
    const later = new Date(NOW.getTime() + 10 * 60_000 + 1);
    expect((await summary(AiFeature.BLOG_CHAT, later)).used).toBe(0);
    const retry = (await take(AiFeature.BLOG_CHAT, id, later)) as UsageTicket;
    await usage.refund(old);
    await usage.complete(retry);
    expect((await summary(AiFeature.BLOG_CHAT, later)).used).toBe(1);
    expect(
      (await summary(AiFeature.BLOG_CHAT, new Date('2026-11-09T17:00:00Z')))
        .used,
    ).toBe(0);
  });
});
