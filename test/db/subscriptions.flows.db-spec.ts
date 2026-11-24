import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import {
  AiFeature,
  AiRequest,
  BillingPlan,
  PaymentIntent,
  PaymentStatus,
} from '@src/mongo/models.js';
import { SubscriptionsModule } from '@src/subscriptions/subscriptions.module.js';
import { SubscriptionsService } from '@src/subscriptions/subscriptions.service.js';
import {
  AiUsageService,
  type UsageTicket,
} from '@src/subscriptions/ai-usage.service.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';

const USER = '7f3b1a52-41a8-4c55-9a77-0b8e2f6a9d10';
const NOW = new Date('2026-11-17T03:00:00Z');
const DAY_MS = 86_400_000;

describe('subscription quota flows (contract matrix)', () => {
  let app: INestApplication;
  let db: MongoService;
  let usage: AiUsageService;
  let subscriptions: SubscriptionsService;
  const requests = () => db.connection.model<AiRequest>(AiRequest.name);
  const intents = () => db.connection.model<PaymentIntent>(PaymentIntent.name);

  function take(
    feature: AiFeature,
    requestId: string = randomUUID(),
    options: { input?: string; continuation?: boolean; now?: Date } = {},
  ): Promise<UsageTicket | null> {
    return usage.consume(
      USER,
      feature,
      {
        requestId,
        prompt: 'prompt',
        input: options.input ?? 'input',
        continuation: options.continuation ?? false,
      },
      options.now ?? NOW,
    );
  }

  async function requireTicket(
    pending: Promise<UsageTicket | null>,
  ): Promise<UsageTicket> {
    const ticket = await pending;
    if (!ticket) throw new Error('Expected a usage ticket');
    return ticket;
  }

  function paid(plan: BillingPlan, capturedAt: Date) {
    return intents().create({
      userId: USER,
      planCode: plan,
      planVersion: 2,
      durationDays: 30,
      amount: plan === BillingPlan.PRO ? 99000n : 49000n,
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
  }

  async function fill(count: number, feature: AiFeature) {
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
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        MongoModule.forTest(createTestMongoUrl('subscription_flows')),
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

  it('grants the 10th Plus image and refuses the 11th', async () => {
    await paid(BillingPlan.PLUS, new Date(NOW.getTime() - DAY_MS));
    await fill(9, AiFeature.BLOG_IMAGE);

    const tenth = await take(AiFeature.BLOG_IMAGE);
    const eleventh = await take(AiFeature.BLOG_IMAGE);

    expect(tenth).not.toBeNull();
    expect(eleventh).toBeNull();
  });

  it('answers AI_REQUEST_IN_PROGRESS for the same request id while its lease is live', async () => {
    const id = randomUUID();
    await requireTicket(take(AiFeature.MEAL_PLAN_CHAT, id));

    await expect(take(AiFeature.MEAL_PLAN_CHAT, id)).rejects.toMatchObject({
      code: 'AI_REQUEST_IN_PROGRESS',
    });
  });

  it('expires an editor continuation once a new purchase starts a different cycle', async () => {
    const id = randomUUID();
    const original = await requireTicket(take(AiFeature.BLOG_CHAT, id));
    await usage.complete(original);
    await paid(BillingPlan.PRO, NOW);

    await expect(
      take(AiFeature.BLOG_CHAT, id, {
        input: 'tool output',
        continuation: true,
      }),
    ).rejects.toMatchObject({ code: 'AI_REQUEST_EXPIRED' });
  });

  it('charges a request reserved before an upgrade to the old period, leaving the new cycle untouched', async () => {
    const before = await requireTicket(take(AiFeature.BLOG_CHAT));
    await paid(BillingPlan.PLUS, NOW);

    await usage.complete(before);

    const summary = await usage.summary(USER, AiFeature.BLOG_CHAT, NOW);
    expect(summary).toMatchObject({ used: 0, limit: 300, period: 'CYCLE' });
  });

  it('frees a slot after a refund so the next request fits at the limit', async () => {
    await fill(4, AiFeature.BLOG_CHAT);
    const last = await requireTicket(take(AiFeature.BLOG_CHAT));
    expect(await take(AiFeature.BLOG_CHAT)).toBeNull();

    await usage.refund(last);

    expect(await take(AiFeature.BLOG_CHAT)).not.toBeNull();
  });

  it('accepts a 200-character request id and rejects 201 characters', async () => {
    await expect(
      take(AiFeature.BLOG_CHAT, 'r'.repeat(200)),
    ).resolves.not.toBeNull();
    await expect(
      take(AiFeature.BLOG_CHAT, 'r'.repeat(201)),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('keeps Pro limits for the whole cycle and returns to the Free daily limit one millisecond after expiry', async () => {
    const capturedAt = new Date(NOW.getTime() - 30 * DAY_MS + 1);
    await paid(BillingPlan.PRO, capturedAt);

    const lastMoment = await usage.summary(USER, AiFeature.BLOG_CHAT, NOW);
    const afterExpiry = await usage.summary(
      USER,
      AiFeature.BLOG_CHAT,
      new Date(NOW.getTime() + 1),
    );

    expect(lastMoment).toMatchObject({ limit: 900, period: 'CYCLE' });
    expect(afterExpiry).toMatchObject({ limit: 5, period: 'DAY' });
  });
});
