import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { aiCostContext } from '../../../../src/ai/telemetry/ai-cost-context.js';
import { AiCostTransportService } from '../../../../src/ai/telemetry/ai-cost-transport.service.js';
import { CostObservation } from '../../../../src/ai/telemetry/cost-observation.js';
import { AiCostCall } from '../../../../src/mongo/models.js';
import { MongoModule } from '../../../../src/mongo/mongo.module.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../../support/mongo-test-db.js';

describe('AiCostTransportService', () => {
  let app: INestApplication;
  let transport: AiCostTransportService;
  let callsModel: Model<AiCostCall>;

  const onlyRow = async () => {
    const rows = await callsModel.find({}).exec();
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('ai_cost_transport'))],
      providers: [AiCostTransportService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    transport = app.get(AiCostTransportService);
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

  it('records native OpenAI usage without inventing a dollar charge or an OpenRouter generation', async () => {
    const underlying = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'resp_fixture',
          model: 'gpt-6-luna',
          usage: { input_tokens: 12, output_tokens: 8 },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const response = await transport.observe(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer fixture-openai-secret' },
        body: JSON.stringify({
          model: 'gpt-6-luna',
          input: 'fixture-private-prompt',
        }),
      },
      underlying,
      'gpt-6-luna',
      'SYSTEM',
      'openai',
    );
    await response.text();
    const row = await onlyRow();
    expect(row).toMatchObject({
      gateway: 'openai',
      provider: 'openai',
      generationId: 'resp_fixture',
      requestedModel: 'gpt-6-luna',
      inputTokens: 12,
      outputTokens: 8,
      costUsd: null,
      costSource: null,
      status: 'SUCCEEDED',
    });
    expect(row.chargeKey).toBeUndefined();
    const stored = JSON.stringify(row);
    expect(stored).not.toContain('fixture-private-prompt');
    expect(stored).not.toContain('fixture-openai-secret');
  });

  it('passes through non-OpenRouter URLs and non-API paths without recording', async () => {
    const underlying = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('ok'));

    await transport.observe(
      'https://example.com/api/v1/chat/completions',
      undefined,
      underlying,
    );
    await transport.observe(
      new URL('https://openrouter.ai/docs'),
      undefined,
      underlying,
    );

    expect(underlying).toHaveBeenCalledTimes(2);
    expect(await callsModel.countDocuments()).toBe(0);
  });

  it('maps OpenRouter URLs to operations and reads model from Request, body string, or fallback', async () => {
    const okJson = () => Response.json({ id: 'gen-1', usage: { cost: 0.001 } });

    const cases: [string, string][] = [
      ['https://openrouter.ai/api/v1/embeddings', 'EMBEDDING'],
      ['https://openrouter.ai/api/v1/rerank', 'RERANK'],
      ['https://openrouter.ai/api/alpha/decisions', 'MODERATION'],
      ['https://openrouter.ai/api/v1/evaluations', 'MODERATION'],
      ['https://openrouter.ai/api/v1/images/generations', 'IMAGE'],
      ['https://openrouter.ai/api/v1/audio/transcriptions', 'TRANSCRIPTION'],
      ['https://openrouter.ai/api/v1/chat/completions', 'CHAT'],
    ];

    for (const [url, expectedOp] of cases) {
      await callsModel.deleteMany({});
      const res = await transport.observe(
        new URL(url),
        { body: new Uint8Array([1, 2]) },
        vi.fn<typeof fetch>().mockResolvedValue(okJson()),
        'fallback/model',
        'KNOWLEDGE',
      );
      await res.text();

      expect(await onlyRow()).toMatchObject({
        operation: expectedOp,
        requestedModel: 'fallback/model',
        feature: 'KNOWLEDGE',
      });
    }

    // Control characters in body model fall back to default 'unknown'.
    await callsModel.deleteMany({});
    const req = new Request('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'bad\nmodel' }),
    });
    const res = await transport.observe(
      req,
      undefined,
      vi.fn<typeof fetch>().mockResolvedValue(okJson()),
    );
    await res.text();
    expect((await onlyRow()).requestedModel).toBe('unknown');
  });

  it('uses AsyncLocalStorage context when present and exposes forModel/fetch wrappers', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          Response.json({ id: 'gen-ctx', usage: { cost: 0.005 } }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const turnId = randomUUID();
    const executionId = randomUUID();
    const userId = randomUUID();

    await aiCostContext.run(
      { turnId, executionId, feature: 'BLOG_CHAT', userId },
      async () => {
        const res = await transport.forModel('blog/model', 'SYSTEM')(
          'https://openrouter.ai/api/v1/chat/completions',
          { method: 'POST', body: JSON.stringify({ model: 'override/model' }) },
        );
        await res.text();
      },
    );

    const recorded = await onlyRow();
    expect(recorded).toMatchObject({
      turnId,
      executionId,
      userId,
      feature: 'BLOG_CHAT',
      requestedModel: 'override/model',
    });
    expect(recorded.costUsd?.toString()).toBe('0.005');

    await callsModel.deleteMany({});
    const plainRes = await transport.fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      { method: 'POST' },
    );
    await plainRes.text();
    expect((await onlyRow()).feature).toBe('SYSTEM');
  });

  it('continues serving the provider response if initial DB insert or finish update fails', async () => {
    vi.spyOn(callsModel, 'create').mockRejectedValueOnce(new Error('db down'));
    const res1 = await transport.observe(
      'https://openrouter.ai/api/v1/chat/completions',
      undefined,
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'g1' })),
    );
    expect(await res1.json()).toEqual({ id: 'g1' });
    expect(await callsModel.countDocuments()).toBe(0);

    vi.spyOn(callsModel, 'updateOne').mockImplementationOnce(() => {
      throw new Error('update failed');
    });
    const res2 = await transport.observe(
      'https://openrouter.ai/api/v1/chat/completions',
      undefined,
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'g2' })),
    );
    expect(await res2.json()).toEqual({ id: 'g2' });
    expect((await onlyRow()).status).toBe('PENDING');
  });

  it('settles bodyless responses immediately and marks stream errors or cancellations', async () => {
    const res204 = await transport.observe(
      'https://openrouter.ai/api/v1/chat/completions',
      undefined,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 204 })),
    );
    expect(res204.status).toBe(204);
    expect(await onlyRow()).toMatchObject({
      status: 'SUCCEEDED',
      httpStatus: 204,
    });

    await callsModel.deleteMany({});
    const res502 = await transport.observe(
      'https://openrouter.ai/api/v1/chat/completions',
      undefined,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 502 })),
    );
    expect(res502.status).toBe(502);
    expect(await onlyRow()).toMatchObject({
      status: 'FAILED',
      httpStatus: 502,
    });

    // Stream read error
    await callsModel.deleteMany({});
    const brokenStream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('stream broken');
      },
    });
    const resBroken = await transport.observe(
      'https://openrouter.ai/api/v1/chat/completions',
      undefined,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(brokenStream, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );
    await expect(resBroken.text()).rejects.toThrow('stream broken');
    expect((await onlyRow()).status).toBe('FAILED');
  });

  it('records ABORTED when underlying fetch rejects after signal abort, and FAILED otherwise', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      transport.observe(
        'https://openrouter.ai/api/v1/chat/completions',
        { signal: controller.signal },
        vi.fn<typeof fetch>().mockRejectedValue(new Error('aborted')),
      ),
    ).rejects.toThrow('aborted');
    expect((await onlyRow()).status).toBe('ABORTED');

    await callsModel.deleteMany({});
    await expect(
      transport.observe(
        'https://openrouter.ai/api/v1/chat/completions',
        undefined,
        vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNRESET')),
      ),
    ).rejects.toThrow('ECONNRESET');
    expect((await onlyRow()).status).toBe('FAILED');
  });

  it('deduplicates repeated generationId charges and rethrows non-unique errors in settleCharge', async () => {
    const obs = new CostObservation();
    obs.accept({ id: 'gen-dup-1', usage: { cost: 0.01 } });

    const first = await callsModel.create({
      _id: randomUUID(),
      turnId: randomUUID(),
      executionId: randomUUID(),
      feature: 'SYSTEM',
      operation: 'CHAT',
      requestedModel: 'm',
    });
    const second = await callsModel.create({
      _id: randomUUID(),
      turnId: randomUUID(),
      executionId: randomUUID(),
      feature: 'SYSTEM',
      operation: 'CHAT',
      requestedModel: 'm',
    });

    await transport.settleCharge(first.id, obs, 'RESPONSE');
    await transport.settleCharge(second.id, obs, 'RESPONSE');

    const secondDoc = await callsModel.findById(second.id).exec();
    expect(secondDoc).toMatchObject({
      duplicateCharge: true,
      costUsd: null,
      costSource: null,
    });
    expect(secondDoc?.chargeKey).toBeUndefined();

    vi.spyOn(callsModel, 'updateOne').mockReturnValueOnce({
      exec: vi.fn().mockRejectedValue(new Error('non-unique failure')),
    } as unknown as ReturnType<Model<AiCostCall>['updateOne']>);
    await expect(
      transport.settleCharge(first.id, obs, 'RESPONSE'),
    ).rejects.toThrow('non-unique failure');
  });
});
