import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '@nestjs/ai';
import { Test } from '@nestjs/testing';
import { embedMany } from 'ai';
import { mockDeep } from 'vitest-mock-extended';
import { openRouterModels } from '@src/ai/providers/openrouter/openrouter.adapter.js';
import { aiCostContext } from '@src/ai/telemetry/ai-cost-context.js';
import { AiCostTransportService } from '@src/ai/telemetry/ai-cost-transport.service.js';
import { ExternalServiceException } from '@src/common/exceptions/external-service.exception.js';
import { KnowledgeModelsService } from '@src/knowledge/retrieval/knowledge-models.service.js';
import type { AiCostCall } from '@src/mongo/models.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';

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
  const embedImages = (count = 1) => {
    const transport = app.get(AiCostTransportService);
    const model = openRouterModels('test-key').embedding(EMBEDDING_MODEL, {
      dimensions: 3,
      fetch: transport.forModel(EMBEDDING_MODEL, 'KNOWLEDGE'),
    });
    const image = [{ inlineData: { mimeType: 'image/jpeg', data: '/9j/' } }];
    return embedMany({
      model,
      values: Array<string>(count).fill(''),
      providerOptions: {
        google: { content: Array.from({ length: count }, () => image) },
      },
      maxRetries: 0,
    });
  };
  const embedImage = () => embedImages(1);

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
            AI_EMBEDDING_MODEL: EMBEDDING_MODEL,
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

    it('puts the images on the wire as image parts, never in the cost row', async () => {
      fetchMock.mockResolvedValue(json(embedded));

      await embedImage();

      const [input, init] = fetchMock.mock.calls[0];
      const body =
        typeof init?.body === 'string'
          ? init.body
          : await (input as Request).clone().text();
      expect(JSON.parse(body)).toMatchObject({
        model: EMBEDDING_MODEL,
        dimensions: 3,
        input: [
          {
            content: [
              {
                type: 'image_url',
                image_url: { url: 'data:image/jpeg;base64,/9j/' },
              },
            ],
          },
        ],
      });
    });

    it('rejects base64 vectors and puts vectors back in input order', async () => {
      fetchMock.mockResolvedValueOnce(
        json({
          ...embedded,
          data: [{ object: 'embedding', index: 0, embedding: 'AAAA' }],
        }),
      );
      await expect(embedImage()).rejects.toThrow(/base64/);

      fetchMock.mockResolvedValueOnce(
        json({
          ...embedded,
          data: [
            { object: 'embedding', index: 1, embedding: [2, 2, 2] },
            { object: 'embedding', index: 0, embedding: [1, 1, 1] },
          ],
        }),
      );
      const { embeddings } = await embedImages(2);
      expect(embeddings).toEqual([
        [1, 1, 1],
        [2, 2, 2],
      ]);
    });
  });

  describe('OCR', () => {
    it('records each page as a CHAT attempt of the OCR model', async () => {
      const mupdf = await import('mupdf');
      const document = new mupdf.PDFDocument();
      document.insertPage(
        -1,
        document.addPage([0, 0, 300, 200], 0, document.addObject({}), ''),
      );
      const pdf = document.saveToBuffer('compress').asUint8Array();
      fetchMock.mockResolvedValue(
        json({
          id: 'gen-ocr-1',
          model: 'mistralai/mistral-small-2603',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '# Trang 1' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 80,
            completion_tokens: 3,
            total_tokens: 83,
            cost: 0.00003,
          },
        }),
      );

      await expect(service.ocrPdf(pdf)).resolves.toEqual(['# Trang 1']);

      const row = await onlyCall();
      expect(row).toMatchObject({
        operation: 'CHAT',
        requestedModel: 'mistralai/mistral-small-2603',
        status: 'SUCCEEDED',
      });
      expect(row.costUsd?.toString()).toBe('0.00003');
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
