import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import request from 'supertest';
import {
  AccountStatus,
  type AiCostCall,
  PostStatus,
  PostType,
  UserRole,
} from '@src/mongo/models.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createPost, createUser } from '@test/support/fixtures.js';

describe('Admin insights flows (HTTP)', () => {
  let e2e: E2eApp;
  let token: string;
  const october2 = new Date('2026-10-02T05:00:00Z');
  const range = 'from=2026-10-01&to=2026-10-03';

  const http = () => request(e2e.app.getHttpServer());
  const dashboard = (query: string) =>
    http()
      .get(`/api/v1/admin/dashboard?${query}`)
      .auth(token, { type: 'bearer' });
  const costs = (path: string, query: string) =>
    http()
      .get(`/api/v1/admin/ai-costs${path}?${query}`)
      .auth(token, { type: 'bearer' });
  const calls = () => e2e.connection.model<AiCostCall>('AiCostCall');

  const addCall = (fields: Partial<AiCostCall>) =>
    calls().create({
      _id: randomUUID(),
      turnId: randomUUID(),
      executionId: randomUUID(),
      feature: 'KNOWLEDGE',
      operation: 'EMBEDDING',
      requestedModel: 'google/gemini-embedding-2',
      status: 'SUCCEEDED',
      startedAt: october2,
      ...fields,
    });

  beforeAll(async () => {
    e2e = await createE2eApp('insights_flows');
    const admin = await createUser(e2e.mongo, {
      username: 'insights.admin',
      role: UserRole.ADMIN,
      createdAt: october2,
    });
    token = await e2e.sign(admin);
  });
  afterAll(async () => e2e?.close());

  describe('dashboard', () => {
    interface Dashboard {
      snapshot: { members: Record<string, number> };
      period: {
        newMembers: number;
        publishedContent: { posts: number; blogs: number; total: number };
      };
      daily: Record<string, number | string>[];
    }
    const body = (value: unknown): Dashboard => value as Dashboard;

    it('counts members as role USER only, excluding DELETED accounts', async () => {
      const before = body((await dashboard(range).expect(200)).body);
      await createUser(e2e.mongo, { createdAt: october2 });
      await createUser(e2e.mongo, {
        createdAt: october2,
        status: AccountStatus.DELETED,
      });
      await createUser(e2e.mongo, {
        createdAt: october2,
        role: UserRole.ADMIN,
      });

      const after = body((await dashboard(range).expect(200)).body);

      expect(after.snapshot.members.total).toBe(
        before.snapshot.members.total + 1,
      );
      expect(after.period.newMembers).toBe(before.period.newMembers + 1);
    });

    it('does not count draft or processing posts as published', async () => {
      const author = await createUser(e2e.mongo);
      const before = body((await dashboard(range).expect(200)).body);
      await createPost(e2e.mongo, {
        authorId: author.id,
        status: PostStatus.DRAFT,
        publishedAt: october2,
      });
      await createPost(e2e.mongo, {
        authorId: author.id,
        status: PostStatus.PROCESSING,
        publishedAt: october2,
      });
      await createPost(e2e.mongo, {
        authorId: author.id,
        publishedAt: october2,
      });

      const after = body((await dashboard(range).expect(200)).body);

      expect(after.period.publishedContent.posts).toBe(
        before.period.publishedContent.posts + 1,
      );
    });

    it('makes the daily rows add up to the period totals', async () => {
      const author = await createUser(e2e.mongo);
      await createPost(e2e.mongo, {
        authorId: author.id,
        type: PostType.POST,
        publishedAt: new Date('2026-10-01T17:30:00Z'),
      });

      const result = body((await dashboard(range).expect(200)).body);

      let posts = 0;
      let members = 0;
      for (const day of result.daily) {
        posts += Number(day.publishedPosts);
        members += Number(day.newMembers);
      }
      expect(posts).toBe(result.period.publishedContent.posts);
      expect(members).toBe(result.period.newMembers);
      expect(result.daily.map((day) => day.date)).toEqual([
        '2026-10-01',
        '2026-10-02',
        '2026-10-03',
      ]);
    });

    it.each([
      ['only from', 'from=2026-10-01'],
      ['reversed dates', 'from=2026-10-03&to=2026-10-01'],
      ['91 days', 'from=2026-01-01&to=2026-04-01'],
      ['an impossible date', 'from=2026-02-29&to=2026-03-01'],
      ['a timestamp', 'from=2026-10-01T00:00:00Z&to=2026-10-03'],
      ['an unknown field', `${range}&timezone=UTC`],
      ['a repeated field', `${range}&from=2026-10-02`],
    ])('refuses %s with 400', async (_case, query) => {
      await dashboard(query).expect(400);
    });

    it('uses the INVALID_DASHBOARD_RANGE code for a reversed range', async () => {
      const response = await dashboard('from=2026-10-03&to=2026-10-01').expect(
        400,
      );

      expect(response.body).toMatchObject({ code: 'INVALID_DASHBOARD_RANGE' });
    });
  });

  describe('AI costs', () => {
    const model = `fixture/model-${randomUUID().slice(0, 8)}`;

    it('answers private, no-store on the CSV export', async () => {
      const response = await costs('/export', range).expect(200);

      expect(response.headers['cache-control']).toBe('private, no-store');
    });

    it('filters by the requested model when the resolved model is unknown', async () => {
      await addCall({ requestedModel: model, resolvedModel: null });

      const response = await costs('/calls', `${range}&model=${model}`).expect(
        200,
      );

      expect(response.body).toMatchObject({
        total: 1,
        items: [{ requestedModel: model }],
      });
    });

    it('matches on the resolved model once known, not the requested one', async () => {
      const requested = `${model}-requested`;
      await addCall({
        requestedModel: requested,
        resolvedModel: `${model}-resolved`,
      });

      const response = await costs(
        '/calls',
        `${range}&model=${requested}`,
      ).expect(200);

      expect(response.body).toMatchObject({ total: 0, items: [] });
    });

    it('reports total, page and limit consistent with the filter', async () => {
      const paged = `${model}-paged`;
      for (let index = 0; index < 3; index += 1) {
        await addCall({ requestedModel: paged });
      }

      const response = await costs(
        '/calls',
        `${range}&model=${paged}&page=2&limit=2`,
      ).expect(200);

      expect(response.body).toMatchObject({ total: 3, page: 2, limit: 2 });
      expect((response.body as { items: unknown[] }).items).toHaveLength(1);
    });

    it('sums known USD exactly as a decimal string and leaves unknowns out', async () => {
      const exact = `${model}-exact`;
      await addCall({
        requestedModel: exact,
        costUsd: Types.Decimal128.fromString('0.1'),
      });
      await addCall({
        requestedModel: exact,
        costUsd: Types.Decimal128.fromString('0.2'),
      });
      await addCall({ requestedModel: exact, costUsd: null });

      const response = await costs('', `${range}&model=${exact}`).expect(200);

      expect(response.body).toMatchObject({
        summary: {
          calls: 3,
          knownCalls: 2,
          unknownCalls: 1,
          knownSpendUsd: '0.3',
        },
      });
    });

    it('excludes a duplicate charge from both known and unknown counts', async () => {
      const duplicated = `${model}-dup`;
      await addCall({
        requestedModel: duplicated,
        costUsd: Types.Decimal128.fromString('0.5'),
      });
      await addCall({
        requestedModel: duplicated,
        costUsd: null,
        duplicateCharge: true,
      });

      const response = await costs('', `${range}&model=${duplicated}`).expect(
        200,
      );

      expect(response.body).toMatchObject({
        summary: {
          calls: 2,
          knownCalls: 1,
          unknownCalls: 0,
          duplicateCalls: 1,
        },
      });
    });

    it('returns null mean and P95 when no turn is fully priced', async () => {
      const unpriced = `${model}-unpriced`;
      await addCall({ requestedModel: unpriced, costUsd: null });

      const response = await costs('', `${range}&model=${unpriced}`).expect(
        200,
      );

      expect(response.body).toMatchObject({
        summary: {
          turns: 1,
          fullyPricedTurns: 0,
          meanKnownTurnUsd: null,
          p95KnownTurnUsd: null,
        },
      });
    });

    it.each([
      ['limit=101'],
      ['limit=0'],
      ['page=0'],
      ['page=100001'],
      ['feature=CHATBOT'],
      [`model=${'m'.repeat(201)}`],
      ['userId=abc'],
    ])('refuses /calls?%s with 400', async (query) => {
      await costs('/calls', query).expect(400);
    });

    it('answers 404 when reconciling an unknown call', async () => {
      await http()
        .post(`/api/v1/admin/ai-costs/calls/${randomUUID()}/reconcile`)
        .auth(token, { type: 'bearer' })
        .expect(404);
    });

    it('returns an already priced call unchanged on reconcile', async () => {
      const row = await addCall({
        generationId: 'gen-priced',
        costUsd: Types.Decimal128.fromString('0.01'),
        costSource: 'RESPONSE',
      });

      const response = await http()
        .post(`/api/v1/admin/ai-costs/calls/${row.id}/reconcile`)
        .auth(token, { type: 'bearer' })
        .expect(201);

      expect(response.body).toMatchObject({
        costUsd: '0.01',
        costSource: 'RESPONSE',
        reconciledAt: null,
      });
    });
  });

  describe('health', () => {
    it('reports liveness without authentication', async () => {
      const response = await http().get('/api/v1/health').expect(200);

      expect(response.body).toMatchObject({ status: 'ok' });
    });

    it('reports the database up on readiness', async () => {
      const response = await http().get('/api/v1/health/ready').expect(200);

      expect(response.body).toEqual({ status: 'ok', database: 'up' });
    });
  });
});
