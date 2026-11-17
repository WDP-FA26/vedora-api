import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '@nestjs/ai';
import { Test } from '@nestjs/testing';
import { mockDeep } from 'vitest-mock-extended';
import { aiCostContext } from '../../../../src/ai/telemetry/ai-cost-context.js';
import { AiCostTransportService } from '../../../../src/ai/telemetry/ai-cost-transport.service.js';
import { ExternalServiceException } from '../../../../src/common/exceptions/external-service.exception.js';
import { KnowledgeModelsService } from '../../../../src/knowledge/retrieval/knowledge-models.service.js';
import type { AiCostCall } from '../../../../src/mongo/models.js';
import { MongoModule } from '../../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../../src/mongo/mongo.service.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../../support/mongo-test-db.js';

/**
 * ai-cost-tracking.md: every HTTP attempt to OpenRouter through an integrated
 * client — including the knowledge REST embedding/OCR/rerank calls moved to
 * @openrouter/sdk — leaves one `ai_cost_calls` row with its operation, the
 * requested model, status and reported USD, and never the payload.
 */

const RERANK_MODEL = 'cohere/rerank-4-pro';
const EMBEDDING_MODEL = 'google/gemini-embedding-2';
const SECRET_QUERY = 'bí mật truy vấn đậu phụ';

const fetchMock = vi.fn<typeof fetch>();

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

describe('Knowledge model calls are cost-tracked', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: KnowledgeModelsService;

  const calls = () => db.connection.model<AiCostCall>('AiCostCall');
  const onlyCall = async () => {
    const rows = await calls().find().exec();
    expect(rows).toHaveLength(1);
    return rows[0];
  };
  const rerank = (signal = AbortSignal.timeout(5000)) =>
    service.rerank(SECRET_QUERY, ['đậu phụ', 'rau cải'], 2, signal);
  const embedImage = () =>
    service.embed([{ image: new Uint8Array([0xff, 0xd8, 0xff]) }]);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('knowledgecosts'))],
      providers: [
        AiCostTransportService,
        KnowledgeModelsService,
        { provide: AiService, useValue: mockDeep<AiService>() },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            OPENROUTER_API_KEY: 'test-key',
            OPENROUTER_RERANK_MODEL: RERANK_MODEL,
            OPENROUTER_EMBEDDING_MODEL: EMBEDDING_MODEL,
            KNOWLEDGE_EMBEDDING_DIMENSIONS: 3,
          }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(KnowledgeModelsService);
  });
  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    await calls().deleteMany({});
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  describe('rerank', () => {
    const reranked = {
      id: 'gen-rerank-1',
      model: RERANK_MODEL,
      results: [
        { index: 1, relevance_score: 0.9, document: { text: 'rau cải' } },
        { index: 0, relevance_score: 0.2, document: { text: 'đậu phụ' } },
      ],
      usage: { cost: 0.0025, total_tokens: 40 },
    };

    it('records one RERANK attempt with the requested model', async () => {
      fetchMock.mockResolvedValue(json(reranked));

      await rerank();

      expect(await onlyCall()).toMatchObject({
        operation: 'RERANK',
        requestedModel: RERANK_MODEL,
        status: 'SUCCEEDED',
        httpStatus: 200,
      });
    });

    it('records the USD the provider reported for a rerank', async () => {
      fetchMock.mockResolvedValue(json(reranked));

      await rerank();

      expect((await onlyCall()).costUsd?.toString()).toBe('0.0025');
    });

    it('returns results best first with their original indexes', async () => {
      fetchMock.mockResolvedValue(json(reranked));

      const results = await rerank();

      expect(results).toEqual([
        { index: 1, relevanceScore: 0.9 },
        { index: 0, relevanceScore: 0.2 },
      ]);
    });

    it('records a provider error as FAILED and surfaces it as an OpenRouter failure', async () => {
      fetchMock.mockResolvedValue(
        json({ error: { code: 503, message: 'overloaded' } }, 503),
      );

      await expect(rerank()).rejects.toBeInstanceOf(ExternalServiceException);

      expect(await onlyCall()).toMatchObject({
        operation: 'RERANK',
        status: 'FAILED',
        httpStatus: 503,
      });
    });

    it('records a rerank cut off by its time budget as ABORTED', async () => {
      const controller = new AbortController();
      fetchMock.mockImplementation((_input, init) => {
        const signal =
          init?.signal ?? (_input instanceof Request ? _input.signal : null);
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          controller.abort();
        });
      });

      await expect(rerank(controller.signal)).rejects.toThrow();

      expect((await onlyCall()).status).toBe('ABORTED');
    });

    it('stores neither the query nor the documents', async () => {
      fetchMock.mockResolvedValue(json(reranked));

      await rerank();

      const row = await calls().findOne().lean().exec();
      expect(JSON.stringify(row)).not.toContain(SECRET_QUERY);
      expect(JSON.stringify(row)).not.toContain('rau cải');
      expect(JSON.stringify(row)).not.toContain('đậu phụ');
    });

    it('makes no provider call and no cost row without documents', async () => {
      await service.rerank(SECRET_QUERY, [], 6, AbortSignal.timeout(1000));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await calls().countDocuments()).toBe(0);
    });
  });

  describe('multimodal embeddings', () => {
    const embedded = {
      id: 'gen-embed-1',
      model: EMBEDDING_MODEL,
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
      usage: { prompt_tokens: 258, total_tokens: 258, cost: 0.00004 },
    };

    it('records one EMBEDDING attempt per image batch with the requested model', async () => {
      fetchMock.mockResolvedValue(json(embedded));

      await embedImage();

      expect(await onlyCall()).toMatchObject({
        operation: 'EMBEDDING',
        requestedModel: EMBEDDING_MODEL,
        status: 'SUCCEEDED',
        inputTokens: 258,
      });
    });

    it('records the reported USD of an embedding', async () => {
      fetchMock.mockResolvedValue(json(embedded));

      await embedImage();

      expect((await onlyCall()).costUsd?.toString()).toBe('0.00004');
    });

    it('does not store the image bytes', async () => {
      fetchMock.mockResolvedValue(json(embedded));

      await embedImage();

      const row = await calls().findOne().lean().exec();
      expect(JSON.stringify(row)).not.toContain('base64');
    });

    it('records one attempt per batch of eight images', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          json({
            ...embedded,
            data: Array.from({ length: 8 }, (_, index) => ({
              object: 'embedding',
              index,
              embedding: [0.1, 0.2, 0.3],
            })),
          }),
        ),
      );
      const images = Array.from({ length: 9 }, () => ({
        image: new Uint8Array([1]),
      }));

      await service.embed(images).catch(() => undefined);

      expect(await calls().countDocuments({ operation: 'EMBEDDING' })).toBe(2);
    });
  });

  describe('OCR', () => {
    it('records the OCR request as a CHAT attempt of the carrier model', async () => {
      fetchMock.mockResolvedValue(
        json({
          id: 'gen-ocr-1',
          model: 'google/gemini-3.1-flash-lite',
          choices: [
            {
              message: {
                annotations: [
                  {
                    type: 'file',
                    file: { content: [{ type: 'text', text: '# Trang 1' }] },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.01 },
        }),
      );

      await service.ocrPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46]));

      expect(await onlyCall()).toMatchObject({
        operation: 'CHAT',
        requestedModel: 'google/gemini-3.1-flash-lite',
        status: 'SUCCEEDED',
      });
    });
  });

  describe('attribution', () => {
    it('attributes calls made while serving a knowledge request to KNOWLEDGE and its admin', async () => {
      fetchMock.mockResolvedValue(
        json({
          model: RERANK_MODEL,
          results: [
            { index: 0, relevance_score: 0.5, document: { text: 'đậu phụ' } },
          ],
        }),
      );

      await aiCostContext.run(
        {
          turnId: 'turn-1',
          executionId: 'exec-1',
          feature: 'KNOWLEDGE',
          userId: 'admin-1',
        },
        () => rerank(),
      );

      expect(await onlyCall()).toMatchObject({
        feature: 'KNOWLEDGE',
        userId: 'admin-1',
        turnId: 'turn-1',
      });
    });

    it('keeps an unknown cost null rather than zero', async () => {
      fetchMock.mockResolvedValue(
        json({
          model: RERANK_MODEL,
          results: [
            { index: 0, relevance_score: 0.5, document: { text: 'đậu phụ' } },
          ],
        }),
      );

      await rerank();

      expect((await onlyCall()).costUsd).toBeNull();
    });
  });
});
