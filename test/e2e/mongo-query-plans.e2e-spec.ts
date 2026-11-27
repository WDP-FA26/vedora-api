import type { Model } from 'mongoose';
import { presentString } from '@src/mongo/partial-match.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';

type Plan = { stages: string[]; indexes: string[] };

/** Every stage and index name in the winning plan, outermost first. */
function summarize(node: unknown, plan: Plan = { stages: [], indexes: [] }) {
  if (typeof node !== 'object' || node === null) return plan;
  const record = node as Record<string, unknown>;
  if (typeof record.stage === 'string') plan.stages.push(record.stage);
  if (typeof record.indexName === 'string') plan.indexes.push(record.indexName);
  for (const value of Object.values(record)) summarize(value, plan);
  return plan;
}

async function winningPlan(
  model: Model<unknown>,
  filter: Record<string, unknown>,
  sort: Record<string, 1 | -1> = {},
): Promise<Plan> {
  const explained = (await model
    .find(filter)
    .sort(sort)
    .limit(20)
    .explain('queryPlanner')) as unknown as {
    queryPlanner: { winningPlan: unknown };
  };
  return summarize(explained.queryPlanner.winningPlan);
}

/**
 * The planner's choice is the same on an empty collection as on a full one, so
 * these pin the index each hot query relies on and that no sort runs in memory.
 */
describe('MongoDB query plans (e2e)', () => {
  let e2e: E2eApp;
  const model = (name: string) =>
    e2e.mongo.connection.model(name) as Model<unknown>;

  beforeAll(async () => {
    e2e = await createE2eApp('mongo_query_plans_e2e');
    await Promise.all(
      [
        'User',
        'PaymentIntent',
        'WorkspaceMember',
        'Workspace',
        'RefreshToken',
        'Post',
        'PostBookmark',
        'PostRepost',
        'PostSummary',
      ].map((name) => model(name).syncIndexes()),
    );
  });

  afterAll(async () => {
    await e2e.close();
  });

  describe('partial unique indexes', () => {
    it('are skipped by a plain equality', async () => {
      const plan = await winningPlan(model('User'), { googleId: 'g-1' });
      expect(plan.stages).toContain('COLLSCAN');
    });

    it.each([
      ['User', { googleId: presentString('g-1') }, 'googleId_1'],
      [
        'PaymentIntent',
        { activeIntentKey: presentString('u-1') },
        'activeIntentKey_1',
      ],
      [
        'PaymentIntent',
        { providerTransactionId: presentString('t-1') },
        'providerTransactionId_1',
      ],
      [
        'WorkspaceMember',
        { pageUserId: presentString('p-1'), userId: 'u-1' },
        'pageUserId_1_userId_1',
      ],
      [
        'Workspace',
        { pageUserId: presentString('p-1'), status: 'APPROVED' },
        'pageUserId_1',
      ],
    ])(
      '%s uses its partial index with presentString',
      async (name, filter, index) => {
        const plan = await winningPlan(model(name), filter);
        expect(plan.stages).not.toContain('COLLSCAN');
        expect(plan.indexes).toContain(index);
      },
    );

    it('lets both $or branches of the refresh-token revoke use an index', async () => {
      const plan = await winningPlan(model('RefreshToken'), {
        $or: [{ userId: 'u-1' }, { actorId: presentString('u-1') }],
        revokedAt: null,
      });
      expect(plan.stages).not.toContain('COLLSCAN');
    });
  });

  describe('timelines sort through an index', () => {
    const newestFirst = { publishedAt: -1, _id: -1 } as const;

    it.each([
      [
        'Post',
        { status: 'PUBLISHED', publishedAt: { $lte: new Date() } },
        newestFirst,
      ],
      [
        'Post',
        { authorId: 'a-1', status: 'PUBLISHED', type: 'POST' },
        newestFirst,
      ],
      [
        'Post',
        {
          authorId: { $in: ['a-1', 'a-2'] },
          status: 'PUBLISHED',
          type: 'POST',
        },
        newestFirst,
      ],
      [
        'Post',
        {
          authorId: 'a-1',
          type: 'POST',
          status: 'DRAFT',
          draftKind: { $ne: null },
        },
        { updatedAt: -1, _id: -1 },
      ],
      ['PostBookmark', { userId: 'u-1' }, { createdAt: -1, _id: -1 }],
      ['PostRepost', { userId: 'u-1' }, { createdAt: -1, _id: -1 }],
      [
        'PostSummary',
        {
          status: 'PENDING',
          claimedAt: { $lt: new Date() },
          attempts: { $lt: 3 },
        },
        { claimedAt: 1, _id: 1 },
      ],
    ] as const)('%s %j', async (name, filter, sort) => {
      const plan = await winningPlan(model(name), filter, sort);
      expect(plan.stages).not.toContain('COLLSCAN');
      expect(plan.stages).not.toContain('SORT');
    });
  });
});
