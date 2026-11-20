import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types, type Model } from 'mongoose';
import { AdminAiCostsService } from '../../../src/admin-ai-costs/admin-ai-costs.service.js';
import { AiCostTransportService } from '../../../src/ai/telemetry/ai-cost-transport.service.js';
import { FeatureUnavailableException } from '../../../src/common/exceptions/feature-unavailable.exception.js';
import { InvalidInputException } from '../../../src/common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../../src/common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../../../src/common/exceptions/state-conflict.exception.js';
import { AiCostCall } from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

describe('AdminAiCostsService', () => {
  let app: INestApplication;
  let service: AdminAiCostsService;
  let callsModel: Model<AiCostCall>;

  const seed = (cost: string | null, extra: Partial<AiCostCall> = {}) =>
    callsModel.create({
      _id: randomUUID(),
      turnId: randomUUID(),
      executionId: randomUUID(),
      userId: randomUUID(),
      feature: 'MEAL_PLAN_CHAT',
      operation: 'CHAT',
      requestedModel: 'requested/model',
      status: 'SUCCEEDED',
      startedAt: new Date('2026-10-01T00:00:00Z'),
      finishedAt: new Date('2026-10-01T00:00:01Z'),
      costUsd: cost === null ? null : Types.Decimal128.fromString(cost),
      costSource: cost === null ? null : 'RESPONSE',
      ...extra,
    });

  const generationPayload = (fields: Record<string, unknown>) => ({
    data: {
      api_type: null,
      app_id: null,
      cache_discount: null,
      cancelled: null,
      created_at: '2026-10-01T00:00:00Z',
      data_region: 'global',
      external_user: null,
      finish_reason: null,
      generation_time: null,
      http_referer: null,
      is_byok: false,
      latency: null,
      moderation_latency: null,
      native_finish_reason: null,
      native_tokens_cached: null,
      native_tokens_completion: null,
      native_tokens_completion_images: null,
      native_tokens_prompt: null,
      native_tokens_reasoning: null,
      num_fetches: null,
      num_input_audio_prompt: null,
      num_media_completion: null,
      num_media_prompt: null,
      num_search_results: null,
      origin: '',
      preset_id: null,
      provider_name: null,
      provider_responses: null,
      router: null,
      service_tier: null,
      streamed: null,
      tokens_completion: null,
      tokens_prompt: null,
      upstream_id: null,
      upstream_inference_cost: null,
      usage: 0,
      user_agent: null,
      web_search_engine: null,
      workspace_id: null,
      ...fields,
    },
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('admin_ai_costs_unit'))],
      providers: [
        AiCostTransportService,
        AdminAiCostsService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            OPENROUTER_API_KEY: 'test-openrouter-key',
          }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    service = app.get(AdminAiCostsService);
    callsModel = app.get<Model<AiCostCall>>(getModelToken(AiCostCall.name));
  });

  beforeEach(async () => {
    await callsModel.deleteMany({}).exec();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (app) {
      await dropTestDatabase(app);
      await app.close();
    }
  });

  describe('report', () => {
    it('returns zeroed summary and null turn averages on an empty period', async () => {
      const result = await service.report({
        from: '2026-10-01',
        to: '2026-10-02',
      });

      expect(result.currency).toBe('USD');
      expect(result.scope).toBe('MATCHED_CALLS');
      expect(result.groupsLimit).toBe(100);
      expect(result.summary).toEqual({
        calls: 0,
        knownCalls: 0,
        unknownCalls: 0,
        duplicateCalls: 0,
        pendingCalls: 0,
        failedCalls: 0,
        knownSpendUsd: '0',
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedTokens: 0,
        unknownTokenCalls: 0,
        turns: 0,
        fullyPricedTurns: 0,
        meanKnownTurnUsd: null,
        p95KnownTurnUsd: null,
      });
      expect(result.daily).toEqual([]);
      expect(result.groups).toEqual([]);
      expect(result.expensiveTurns).toEqual([]);
    });

    it('computes Decimal128 totals, nearest-rank P95, UTC+7 boundaries, and feature/model filters', async () => {
      // 20 turns with exact costs 1..20 so nearest-rank P95 = ceil(0.95 * 20) = 19.
      for (let i = 1; i <= 20; i += 1) {
        await seed(String(i), {
          resolvedModel: 'actual/model',
          feature: 'BLOG_CHAT',
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: 2,
          cachedTokens: 1,
        });
      }
      // Incomplete / duplicate / pending / failed calls excluded from fully-priced mean/P95.
      await seed(null, {
        resolvedModel: 'actual/model',
        feature: 'BLOG_CHAT',
        status: 'FAILED',
      });
      await seed(null, {
        resolvedModel: 'actual/model',
        feature: 'BLOG_CHAT',
        duplicateCharge: true,
      });
      await seed(null, {
        resolvedModel: 'actual/model',
        feature: 'BLOG_CHAT',
        status: 'PENDING',
      });
      // Different feature & next Bangkok day (2026-10-01T17:00:00Z = 2026-10-02 Bangkok).
      await seed('100', {
        feature: 'KNOWLEDGE',
        startedAt: new Date('2026-10-01T17:00:00Z'),
      });

      const filtered = await service.report({
        from: '2026-10-01',
        to: '2026-10-01',
        feature: 'BLOG_CHAT',
        model: 'actual/model',
      });

      expect(filtered.summary).toMatchObject({
        calls: 23,
        knownCalls: 20,
        unknownCalls: 2,
        duplicateCalls: 1,
        pendingCalls: 1,
        failedCalls: 1,
        knownSpendUsd: '210',
        inputTokens: 200,
        outputTokens: 100,
        reasoningTokens: 40,
        cachedTokens: 20,
        unknownTokenCalls: 3,
        turns: 23,
        fullyPricedTurns: 20,
        meanKnownTurnUsd: '10.5',
        p95KnownTurnUsd: '19',
      });
      expect(filtered.daily).toHaveLength(1);
      expect(filtered.daily[0].date).toBe('2026-10-01');
      expect(filtered.groups[0]).toMatchObject({
        model: 'actual/model',
        feature: 'BLOG_CHAT',
        operation: 'CHAT',
        knownSpendUsd: '210',
      });
      expect(filtered.expensiveTurns).toHaveLength(20);
      expect(filtered.expensiveTurns[0].knownSpendUsd).toBe('20');
    });
  });

  describe('list & csv', () => {
    it('lists paginated calls newest-first with exact Decimal128 strings and ISO dates', async () => {
      await seed('0.00125', {
        startedAt: new Date('2026-10-01T01:00:00Z'),
        resolvedModel: 'm/1',
      });
      await seed(null, {
        startedAt: new Date('2026-10-01T02:00:00Z'),
        finishedAt: null,
        resolvedModel: null,
      });

      const page1 = await service.list({
        from: '2026-10-01',
        to: '2026-10-01',
        page: 1,
        limit: 1,
      });
      expect(page1.total).toBe(2);
      expect(page1.page).toBe(1);
      expect(page1.limit).toBe(1);
      expect(page1.items[0]).toMatchObject({
        costUsd: null,
        finishedAt: null,
        reconciledAt: null,
      });

      const page2 = await service.list({
        from: '2026-10-01',
        to: '2026-10-01',
        page: 2,
        limit: 1,
      });
      expect(page2.items[0]).toMatchObject({
        costUsd: '0.00125',
        resolvedModel: 'm/1',
        startedAt: '2026-10-01T01:00:00.000Z',
      });
    });

    it('exports UTF-8 BOM CSV, leaves null cost blank, and escapes formula prefixes & quotes', async () => {
      await seed('0.0005', {
        requestedModel: '=SUM(A1)',
        resolvedModel: '+cmd',
        provider: '-minus',
        generationId: '@at',
      });
      await seed(null, {
        requestedModel: 'has "quotes"',
        provider: '\ttab',
      });

      const csv = await service.csv({ from: '2026-10-01', to: '2026-10-01' });
      expect(csv.startsWith('\ufeff"id",')).toBe(true);
      expect(csv).toContain('"\'=SUM(A1)"');
      expect(csv).toContain('"\'+cmd"');
      expect(csv).toContain('"\'-minus"');
      expect(csv).toContain('"\'@at"');
      expect(csv).toContain('"\'\ttab"');
      expect(csv).toContain('"has ""quotes"""');
      expect(csv).toContain(',"",');
    });

    it('rejects CSV export when more than 10000 calls match', async () => {
      const exec = vi
        .fn()
        .mockResolvedValue(Array.from({ length: 10001 }, () => ({})));
      const limit = vi.fn().mockReturnValue({ exec });
      const sort = vi.fn().mockReturnValue({ limit });
      vi.spyOn(callsModel, 'find').mockReturnValueOnce({
        sort,
      } as unknown as ReturnType<Model<AiCostCall>['find']>);

      await expect(service.csv({})).rejects.toBeInstanceOf(
        InvalidInputException,
      );
    });
  });

  describe('reconcile', () => {
    it('throws NOT_FOUND when call does not exist', async () => {
      await expect(service.reconcile(randomUUID())).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
    });

    it('returns existing row without calling OpenRouter if already priced or marked duplicateCharge', async () => {
      const priced = await seed('0.02', { generationId: 'gen-priced' });
      const duplicate = await seed(null, {
        generationId: 'gen-dup',
        duplicateCharge: true,
      });
      const fetchSpy = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchSpy);

      const res1 = await service.reconcile(priced.id);
      const res2 = await service.reconcile(duplicate.id);
      expect(res1.costUsd).toBe('0.02');
      expect(res2.duplicateCharge).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws CONFLICT when generationId is missing or PENDING attempt is under 15 minutes old', async () => {
      const noGen = await seed(null, { generationId: null });
      const freshPending = await seed(null, {
        generationId: 'gen-fresh',
        status: 'PENDING',
        startedAt: new Date(Date.now() - 60_000),
      });

      await expect(service.reconcile(noGen.id)).rejects.toBeInstanceOf(
        StateConflictException,
      );
      await expect(service.reconcile(freshPending.id)).rejects.toBeInstanceOf(
        StateConflictException,
      );
    });

    it('throws SERVICE_UNAVAILABLE on provider failure, mismatched ID, or missing totalCost', async () => {
      const row = await seed(null, {
        generationId: 'gen-123',
        status: 'PENDING',
        startedAt: new Date(Date.now() - 20 * 60_000),
      });

      const fetchMock = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce(
          Response.json(
            generationPayload({ id: 'gen-other', total_cost: 0.5 }),
          ),
        )
        .mockResolvedValueOnce(
          Response.json(generationPayload({ id: 'gen-123', total_cost: null })),
        );
      vi.stubGlobal('fetch', fetchMock);

      await expect(service.reconcile(row.id)).rejects.toBeInstanceOf(
        FeatureUnavailableException,
      );
      await expect(service.reconcile(row.id)).rejects.toBeInstanceOf(
        FeatureUnavailableException,
      );
      await expect(service.reconcile(row.id)).rejects.toBeInstanceOf(
        FeatureUnavailableException,
      );
    });

    it('settles charge with GENERATION source and reconciledAt on valid OpenRouter response', async () => {
      const row = await seed(null, {
        generationId: 'gen-reconcile-ok',
        status: 'ABORTED',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json(
            generationPayload({
              id: 'gen-reconcile-ok',
              model: 'resolved/model',
              provider_name: 'DeepInfra',
              total_cost: 0.0042,
              native_tokens_prompt: 120,
              native_tokens_completion: 30,
              native_tokens_reasoning: 5,
              native_tokens_cached: 10,
            }),
          ),
        ),
      );

      const updated = await service.reconcile(row.id);
      expect(updated).toMatchObject({
        id: row.id,
        status: 'ABORTED',
        costUsd: '0.0042',
        costSource: 'GENERATION',
        resolvedModel: 'resolved/model',
        provider: 'DeepInfra',
        inputTokens: 120,
        outputTokens: 30,
        reasoningTokens: 5,
        cachedTokens: 10,
      });
      expect(updated.reconciledAt).not.toBeNull();
    });
  });
});
