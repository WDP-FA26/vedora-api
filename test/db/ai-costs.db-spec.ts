import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { experimental_evaluate as evaluate } from 'ai';
import { evaluationModel } from '../../src/common/decision/decision.js';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AdminAiCostsModule } from '../../src/admin-ai-costs/admin-ai-costs.module.js';
import { AdminAiCostsService } from '../../src/admin-ai-costs/admin-ai-costs.service.js';
import { AiCostTransportService } from '../../src/ai/telemetry/ai-cost-transport.service.js';
import { aiCostContext } from '../../src/ai/telemetry/ai-cost-context.js';
import { MongoModule } from '../../src/mongo/mongo.module.js';
import { MongoService } from '../../src/mongo/mongo.service.js';
import { AiCostCall, UserRole } from '../../src/mongo/models.js';
import { configureApp } from '../../src/app.setup.js';
import { AppExceptionFilter } from '../../src/common/exceptions/app-exception.filter.js';
import { createUser } from '../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../support/mongo-test-db.js';

describe('AI cost telemetry and Admin reports with MongoDB', () => {
  let app: INestApplication<App>,
    db: MongoService,
    transport: AiCostTransportService,
    admin: AdminAiCostsService;
  let adminToken: string, memberToken: string;
  const path = '/api/v1/admin/ai-costs';
  const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
  const userId = randomUUID();
  const scope = () => ({
    turnId: randomUUID(),
    executionId: randomUUID(),
    userId,
    feature: 'MEAL_PLAN_CHAT',
  });
  const jsonResponse = (data: object, status = 200) =>
    Response.json(data, { status, headers: { 'x-provider': 'fixture' } });
  async function call(data: object, status = 200, url = endpoint) {
    const response = await transport.observe(
      url,
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'openrouter/auto',
          messages: [{ role: 'user', content: 'PRIVATE_PROMPT_DO_NOT_STORE' }],
        }),
      },
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(data, status)),
    );
    await response.text();
    return db.connection
      .model<AiCostCall>(AiCostCall.name)
      .findOne()
      .sort({ startedAt: -1 })
      .exec();
  }
  function seed(cost: string | null, extra: Partial<AiCostCall> = {}) {
    return db.connection.model<AiCostCall>(AiCostCall.name).create({
      ...scope(),
      operation: 'CHAT',
      requestedModel: 'fixture/model',
      status: 'SUCCEEDED',
      finishedAt: new Date(),
      costUsd: cost === null ? null : Types.Decimal128.fromString(cost),
      ...extra,
    });
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        MongoModule.forTest(createTestMongoUrl('ai_costs')),
        JwtModule.register({ global: true, secret: 'ai-cost-fixture-secret' }),
        AdminAiCostsModule,
      ],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({
            API_PREFIX: 'api/v1',
            OPENROUTER_API_KEY: 'fixture-not-a-live-key',
          }),
        },
        { provide: APP_FILTER, useClass: AppExceptionFilter },
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          API_PREFIX: 'api/v1',
          OPENROUTER_API_KEY: 'fixture-not-a-live-key',
        }),
      )
      .compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(MongoService);
    await prepareTestDatabase(app);
    transport = app.get(AiCostTransportService);
    admin = app.get(AdminAiCostsService);
    const makeToken = async (role: UserRole) => {
      const user = await createUser(db, {
        username: `cost-${role}`,
        email: `cost-${role}@fixture.test`,
        role,
      });
      return app
        .get(JwtService)
        .sign({ sub: user.id, username: user.username });
    };
    adminToken = await makeToken(UserRole.ADMIN);
    memberToken = await makeToken(UserRole.USER);
  });
  beforeEach(async () => {
    await db.connection
      .model<AiCostCall>(AiCostCall.name)
      .deleteMany({})
      .exec();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    if (app) await dropTestDatabase(app);
    if (app) await app.close();
  });

  it('records native reported USD, actual model/provider and tokens without payloads', async () => {
    const row = await call({
      id: 'gen-billed',
      model: 'actual/model',
      provider: 'Fixture Provider',
      usage: {
        cost: 0.000123,
        prompt_tokens: 100,
        completion_tokens: 40,
        completion_tokens_details: { reasoning_tokens: 20 },
        prompt_tokens_details: { cached_tokens: 80 },
      },
      choices: [{ message: { content: 'PRIVATE_ANSWER' } }],
    });
    expect(row?.costUsd?.toString()).toBe('0.000123');
    expect(row).toMatchObject({
      resolvedModel: 'actual/model',
      generationId: 'gen-billed',
      status: 'SUCCEEDED',
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 20,
      cachedTokens: 80,
    });
    expect(JSON.stringify(row)).not.toMatch(/PRIVATE_|fixture-not-a-live-key/);
  });
  it.each([
    ['embeddings', 'EMBEDDING'],
    ['rerank', 'RERANK'],
    ['decisions', 'MODERATION'],
    ['images', 'IMAGE'],
    ['audio/transcriptions', 'TRANSCRIPTION'],
  ])('observes %s attempts with reported cost', async (route, operation) => {
    const row = await call(
      { id: `gen-${operation}`, usage: { cost: 0.01 } },
      200,
      `https://openrouter.ai/api/v1/${route}`,
    );
    expect(row?.operation).toBe(operation);
    expect(row?.costUsd?.toString()).toBe('0.01');
  });
  it('keeps a reported zero known and absent cost unknown', async () => {
    await call({ id: 'gen-free', usage: { cost: 0 } });
    await call({ id: 'gen-unknown', usage: { prompt_tokens: 10 } });
    const report = await admin.report({});
    expect(report.summary).toMatchObject({
      calls: 2,
      knownCalls: 1,
      unknownCalls: 1,
      knownSpendUsd: '0',
      fullyPricedTurns: 1,
      meanKnownTurnUsd: '0',
    });
  });
  it('observes the actual SDK Decisions alpha endpoint', async () => {
    const underlying = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({
          id: 'gen-alpha',
          model: 'typesafe/jev-1.14',
          answers: { verdict: { type: 'choice', choice: 'allow' } },
          usage: { input_tokens: 100, output_tokens: 0, cost: 0.00001 },
        }),
      );
    const model = evaluationModel({
      apiKey: 'fixture',
      modelId: 'typesafe/jev-1.14',
      fetch: (input, init) => transport.observe(input, init, underlying),
    });
    const result = await evaluate({
      model,
      state: 'fixture',
      questions: {
        verdict: {
          type: 'choice',
          instructions: 'Choose allow',
          criteria: { allow: 'allow', deny: 'deny' },
        },
      },
    });
    expect(result.answers.verdict.choice).toBe('allow');
    expect(underlying.mock.calls[0][0]).toBe(
      'https://openrouter.ai/api/alpha/decisions',
    );
    const row = await db.connection
      .model<AiCostCall>(AiCostCall.name)
      .findOne()
      .exec();
    expect(row?.operation).toBe('MODERATION');
    expect(row?.costUsd?.toString()).toBe('0.00001');
  });
  it('parses terminal SSE billing without altering the streamed bytes', async () => {
    const content =
      'data: {"id":"gen-stream","model":"actual/model"}\n\ndata: {"usage":{"cost":0.012,"prompt_tokens":50,"completion_tokens":20}}\n\ndata: [DONE]\n\n';
    const encoded = new TextEncoder().encode(content);
    const response = await transport.observe(
      endpoint,
      {},
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < encoded.length; i += 7)
                c.enqueue(encoded.slice(i, i + 7));
              c.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
    );
    expect(await response.text()).toBe(content);
    expect(
      (
        await db.connection.model<AiCostCall>(AiCostCall.name).findOne().exec()
      )?.costUsd?.toString(),
    ).toBe('0.012');
  });
  it('records charges on failed responses and every retry attempt', async () => {
    await call({ error: { message: 'refused' }, usage: { cost: 0.001 } }, 500);
    await call({ id: 'gen-retry', usage: { cost: 0.002 } });
    expect((await admin.report({})).summary).toMatchObject({
      calls: 2,
      failedCalls: 1,
      knownSpendUsd: '0.003',
    });
  });
  it('records network failures as unknown instead of zero', async () => {
    await expect(
      transport.observe(
        endpoint,
        {},
        vi.fn<typeof fetch>().mockRejectedValue(new Error('network')),
      ),
    ).rejects.toThrow('network');
    expect((await admin.report({})).summary).toMatchObject({
      failedCalls: 1,
      unknownCalls: 1,
      fullyPricedTurns: 0,
      meanKnownTurnUsd: null,
      p95KnownTurnUsd: null,
    });
  });
  it('deduplicates charges for the same provider generation without discarding attempts', async () => {
    await call({ id: 'gen-duplicate', usage: { cost: 0.03 } });
    await call({ id: 'gen-duplicate', usage: { cost: 0.03 } });
    expect((await admin.report({})).summary).toMatchObject({
      calls: 2,
      knownCalls: 1,
      duplicateCalls: 1,
      unknownCalls: 0,
      knownSpendUsd: '0.03',
    });
  });
  it('correlates concurrent multi-step turns without leaking user identity', async () => {
    const first = scope(),
      second = { ...scope(), userId: randomUUID() };
    await Promise.all([
      aiCostContext.run(first, async () => {
        await call({ usage: { cost: 0.01 } });
        await call({ usage: { cost: 0.02 } });
      }),
      aiCostContext.run(second, () => call({ usage: { cost: 0.04 } })),
    ]);
    const report = await admin.report({});
    expect(report.summary).toMatchObject({
      calls: 3,
      turns: 2,
      fullyPricedTurns: 2,
      knownSpendUsd: '0.07',
      meanKnownTurnUsd: '0.035',
      p95KnownTurnUsd: '0.04',
    });
    const rows = await db.connection
      .model<AiCostCall>(AiCostCall.name)
      .find({ turnId: first.turnId })
      .exec();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.userId === first.userId)).toBe(true);
  });
  it('computes nearest-rank P95 and excludes incomplete turns from mean', async () => {
    for (let i = 1; i <= 20; i++) await seed(String(i));
    await seed(null);
    const report = await admin.report({});
    expect(report.summary).toMatchObject({
      turns: 21,
      fullyPricedTurns: 20,
      knownSpendUsd: '210',
      meanKnownTurnUsd: '10.5',
      p95KnownTurnUsd: '19',
    });
  });
  it('uses Bangkok inclusive date boundaries and exact resolved-model filters', async () => {
    const fields = { resolvedModel: 'actual/model', feature: 'BLOG_CHAT' };
    await seed('1', { ...fields, startedAt: new Date('2026-09-30T17:00:00Z') });
    await seed('2', {
      ...fields,
      startedAt: new Date('2026-10-01T16:59:59.999Z'),
    });
    await seed('4', { ...fields, startedAt: new Date('2026-10-01T17:00:00Z') });
    const report = await admin.report({
      from: '2026-10-01',
      to: '2026-10-01',
      model: 'actual/model',
      feature: 'BLOG_CHAT',
    });
    expect(report.summary.knownSpendUsd).toBe('3');
    expect(report.daily[0].date).toBe('2026-10-01');
    expect(
      (
        await admin.report({
          from: '2026-10-01',
          to: '2026-10-01',
          model: '$requestedModel',
        })
      ).summary.calls,
    ).toBe(0);
  });
  it('persists an aborted stream and manually reconciles its missing cost by generation ID', async () => {
    const response = await transport.observe(
      endpoint,
      {},
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode('data: {"id":"gen-abort"}\n\n'),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    const row = (await db.connection
      .model<AiCostCall>(AiCostCall.name)
      .findOne()
      .exec())!;
    expect(row).toMatchObject({
      status: 'ABORTED',
      generationId: 'gen-abort',
      costUsd: null,
    });
    const provider = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          id: 'gen-abort',
          model: 'resolved/model',
          total_cost: 0.017,
          native_tokens_prompt: 100,
          native_tokens_completion: 20,
        },
      }),
    );
    vi.stubGlobal('fetch', provider);
    const result = await admin.reconcile(row.id);
    expect(result).toMatchObject({
      costUsd: '0.017',
      costSource: 'GENERATION',
      status: 'ABORTED',
    });
    expect(provider.mock.calls[0][0]).toBe(
      'https://openrouter.ai/api/v1/generation?id=gen-abort',
    );
    await admin.reconcile(row.id);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('rejects reconciliation without ID or while the request may still be running', async () => {
    const noId = await seed(null),
      pending = await seed(null, {
        status: 'PENDING',
        generationId: 'gen-pending',
      });
    await expect(admin.reconcile(noId.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(admin.reconcile(pending.id)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  it('does not accept a mismatched generation response or fabricate a missing price', async () => {
    const row = await seed(null, { generationId: 'gen-original' });
    const provider = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ data: { id: 'gen-other', total_cost: 99 } }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'gen-original' } }));
    vi.stubGlobal('fetch', provider);
    await expect(admin.reconcile(row.id)).rejects.toMatchObject({
      statusCode: 503,
    });
    await expect(admin.reconcile(row.id)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(
      (
        await db.connection
          .model<AiCostCall>(AiCostCall.name)
          .findById(row.id)
          .exec()
      )?.costUsd,
    ).toBeNull();
  });
  it('enforces Admin role on report, rows, export and reconcile', async () => {
    for (const route of [path, `${path}/calls`, `${path}/export`]) {
      await request(app.getHttpServer()).get(route).expect(401);
      await request(app.getHttpServer())
        .get(route)
        .auth(memberToken, { type: 'bearer' })
        .expect(403);
    }
    await request(app.getHttpServer())
      .post(`${path}/calls/${randomUUID()}/reconcile`)
      .auth(memberToken, { type: 'bearer' })
      .expect(403);
    const result = await request(app.getHttpServer())
      .get(path)
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
  });
  it.each([
    '?from=2026-10-01',
    '?from=2026-02-30&to=2026-03-01',
    '?from=2026-01-01&to=2026-12-31',
    '?feature=untrusted',
    '?injected=yes',
  ])('validates report query %s', async (query) => {
    await request(app.getHttpServer())
      .get(path + query)
      .auth(adminToken, { type: 'bearer' })
      .expect(400);
  });
  it('exports exact decimal USD with missing values blank and spreadsheet formulas escaped', async () => {
    await seed('0.000123', {
      requestedModel: '=DANGEROUS()',
      provider: '+FORMULA',
    });
    await seed(null);
    const result = await request(app.getHttpServer())
      .get(`${path}/export`)
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(result.headers['content-type']).toContain('text/csv');
    expect(result.text).toContain('"0.000123"');
    expect(result.text).toContain('"\'=DANGEROUS()"');
    expect(result.text).toContain('"\'+FORMULA"');
    expect(result.text).not.toMatch(/PRIVATE_|fixture-not-a-live-key/);
    const listed = await request(app.getHttpServer())
      .get(`${path}/calls?page=1&limit=1`)
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    const body = listed.body as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(2);
  });
});
