import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { parseOpenRouterPayload } from '@src/ai/providers/openrouter/openrouter.cost.js';
import { aiCostContext } from '@src/ai/telemetry/ai-cost-context.js';
import { AiCostTransportService } from '@src/ai/telemetry/ai-cost-transport.service.js';
import { CostObservation } from '@src/ai/telemetry/cost-observation.js';
import { AiCostCall } from '@src/mongo/models.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';

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

  it('records a moderation call through the chat API as MODERATION when told so', async () => {
    const res = await transport.observe(
      new URL('https://openrouter.ai/api/v1/chat/completions'),
      { body: new Uint8Array([1, 2]) },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ id: 'gen-1', usage: { cost: 0.001 } }),
        ),
      'anthropic/claude-haiku-5.5',
      'GUEST_CHAT',
      'MODERATION',
    );
    await res.text();

    expect(await onlyRow()).toMatchObject({ operation: 'MODERATION' });
  });

  it('does not record calls outside the OpenRouter API path', async () => {
    const underlying = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}'));
    await transport.observe(
      new URL('https://openrouter.ai/api/alpha/decisions'),
      {},
      underlying,
    );

    expect(underlying).toHaveBeenCalledTimes(1);
    expect(await callsModel.countDocuments()).toBe(0);
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
    parseOpenRouterPayload({ id: 'gen-dup-1', usage: { cost: 0.01 } }, obs);

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

    await transport.settleCharge(first.id, 'openrouter', obs, 'RESPONSE');
    await transport.settleCharge(second.id, 'openrouter', obs, 'RESPONSE');

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
      transport.settleCharge(first.id, 'openrouter', obs, 'RESPONSE'),
    ).rejects.toThrow('non-unique failure');
  });

  const gatewayMetadata = {
    gateway: {
      cost: '0.0015',
      generationId: 'gen_01GATEWAY',
      routing: {
        canonicalSlug: 'anthropic/claude-haiku-5.5',
        finalProvider: 'anthropic',
      },
    },
  };

  it('records an AI Gateway generate call from providerMetadata.gateway and AI SDK usage', async () => {
    const res = await transport.observe(
      new URL('https://ai-gateway.vercel.sh/v4/ai/language-model'),
      { body: '{"prompt":[]}' },
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            inputTokens: { total: 120, cacheRead: 100, cacheWrite: 10 },
            outputTokens: { total: 7, reasoning: 2 },
          },
          providerMetadata: gatewayMetadata,
        }),
      ),
      'anthropic/claude-haiku-5.5',
    );
    await res.text();

    const row = await onlyRow();
    expect(row).toMatchObject({
      operation: 'CHAT',
      billedBy: 'gateway',
      status: 'SUCCEEDED',
      requestedModel: 'anthropic/claude-haiku-5.5',
      resolvedModel: 'anthropic/claude-haiku-5.5',
      provider: 'anthropic',
      generationId: 'gen_01GATEWAY',
      chargeKey: 'gateway:gen_01GATEWAY',
      inputTokens: 120,
      outputTokens: 7,
      reasoningTokens: 2,
      cachedTokens: 100,
      cacheWriteTokens: 10,
    });
    expect(row.costUsd?.toString()).toBe('0.0015');
  });

  it('reads a Gateway stream finish part and an embedding result', async () => {
    const stream = [
      'data: {"type":"response-metadata","id":"msg_1","modelId":"claude-haiku-5-5"}',
      'data: {"type":"text-delta","id":"t","delta":"hi"}',
      `data: ${JSON.stringify({ type: 'finish', usage: { inputTokens: { total: 5 }, outputTokens: { total: 1 } }, providerMetadata: gatewayMetadata })}`,
      '',
    ].join('\n\n');
    const streamed = await transport.observe(
      new URL('https://ai-gateway.vercel.sh/v4/ai/language-model'),
      { body: '{}' },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(stream, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
      'anthropic/claude-haiku-5.5',
    );
    await streamed.text();
    const chat = await onlyRow();
    expect(chat).toMatchObject({
      billedBy: 'gateway',
      generationId: 'gen_01GATEWAY',
      inputTokens: 5,
      outputTokens: 1,
    });
    expect(chat.costUsd?.toString()).toBe('0.0015');

    await callsModel.deleteMany({}).exec();
    const embedded = await transport.observe(
      new URL('https://ai-gateway.vercel.sh/v4/ai/embedding-model'),
      { body: '{}' },
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          embeddings: [[0.1]],
          usage: { tokens: 3 },
          providerMetadata: {
            gateway: { cost: '0.0000006', generationId: 'gen_01EMBED' },
          },
        }),
      ),
      'google/gemini-embedding-2',
      'KNOWLEDGE',
    );
    await embedded.text();
    const embedding = await onlyRow();
    expect(embedding).toMatchObject({
      operation: 'EMBEDDING',
      billedBy: 'gateway',
      inputTokens: 3,
      chargeKey: 'gateway:gen_01EMBED',
    });
  });

  it('marks a Gateway stream error part as FAILED', async () => {
    const res = await transport.observe(
      new URL('https://ai-gateway.vercel.sh/v4/ai/language-model'),
      { body: '{}' },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('data: {"type":"error","error":"boom"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );
    await res.text();
    expect(await onlyRow()).toMatchObject({ status: 'FAILED' });
  });
});
