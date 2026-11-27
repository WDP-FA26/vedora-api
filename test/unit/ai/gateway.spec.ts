import { ConfigService } from '@nestjs/config';
import { embed, generateText, stepCountIs } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatewayModels } from '@src/ai/providers/gateway/gateway.adapter.js';
import { PromptCache } from '@src/ai/prompt-cache.js';
import {
  activeProvider,
  aiModels,
  modelIdFor,
  providerDialect,
} from '@src/ai/providers/provider-registry.js';
import { webSearchTool } from '@src/ai/tools/web-search.tool.js';

type Body = Record<string, unknown>;

const finish = {
  finishReason: { unified: 'stop', raw: 'end_turn' },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
};

function fakeGateway(content: unknown[]): {
  bodies: Body[];
  fetch: typeof fetch;
} {
  const bodies: Body[] = [];
  const fakeFetch: typeof fetch = (_input, init) => {
    bodies.push(
      JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Body,
    );
    return Promise.resolve(Response.json({ content, ...finish }));
  };
  return { bodies, fetch: fakeFetch };
}

describe('AI Gateway adapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is picked by AI_PROVIDER and spells caching and effort for the Gateway', () => {
    vi.stubEnv('AI_PROVIDER', 'gateway');
    expect(activeProvider()).toBe('gateway');

    expect(PromptCache.system('rules').providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
    });
    expect(PromptCache.textPart('rules', '5m').providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });

    const agent = PromptCache.agent({
      session: 'vedora-planner',
      instructions: 'rules',
      effort: 'medium',
    });
    expect(agent.providerOptions).toEqual({
      gateway: {
        sessionId: PromptCache.sessionId('vedora-planner'),
        caching: 'auto',
      },
    });
    expect(agent.reasoning).toBe('medium');

    const single = PromptCache.singleTurn({
      session: 'vedora-guardrail',
      instructions: 'rules',
    });
    expect(single.providerOptions).toEqual({
      gateway: { sessionId: 'vedora-guardrail' },
    });
    expect(single).not.toHaveProperty('reasoning');
  });

  it('sends the model effort unless the call sets one, and the provider order', async () => {
    const gateway = fakeGateway([{ type: 'text', text: 'ok' }]);
    const model = gatewayModels('test-key').chat('anthropic/claude-haiku-5.5', {
      effort: 'low',
      providerOrder: ['anthropic'],
      fetch: gateway.fetch,
    });

    await generateText({ model, prompt: 'hi' });
    await generateText({
      model,
      prompt: 'hi',
      reasoning: 'medium',
      providerOptions: { gateway: { caching: 'auto' } },
    });

    expect(gateway.bodies[0]).toMatchObject({
      reasoning: 'low',
      providerOptions: { gateway: { order: ['anthropic'] } },
    });
    expect(gateway.bodies[1]).toMatchObject({
      reasoning: 'medium',
      providerOptions: { gateway: { order: ['anthropic'], caching: 'auto' } },
    });
  });

  it('searches with Parallel fast and reports its results as url sources', async () => {
    vi.stubEnv('AI_PROVIDER', 'gateway');
    const gateway = fakeGateway([
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'webSearch',
        input: '{"objective":"pho chay kcal"}',
        providerExecuted: true,
      },
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'webSearch',
        result: {
          search_id: 's-1',
          results: [
            {
              url: 'https://example.test/pho',
              title: 'Phở chay',
              excerpts: [],
            },
            { title: 'no url', excerpts: [] },
          ],
        },
      },
      { type: 'text', text: 'About 400 kcal.' },
    ]);
    const model = gatewayModels('test-key').chat('anthropic/claude-haiku-5.5', {
      fetch: gateway.fetch,
    });

    const result = await generateText({
      model,
      prompt: 'kcal?',
      tools: { webSearch: webSearchTool() },
      stopWhen: stepCountIs(1),
    });

    expect(gateway.bodies[0].tools).toEqual([
      {
        type: 'provider',
        id: 'gateway.parallel_search',
        name: 'webSearch',
        args: { mode: 'fast', maxResults: 5 },
      },
    ]);
    expect(result.sources).toEqual([
      expect.objectContaining({
        sourceType: 'url',
        url: 'https://example.test/pho',
        title: 'Phở chay',
      }),
    ]);
  });

  it('asks for the configured embedding size', async () => {
    const bodies: Body[] = [];
    const fakeFetch: typeof fetch = (_input, init) => {
      bodies.push(
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Body,
      );
      return Promise.resolve(
        Response.json({ embeddings: [[0.1, 0.2]], usage: { tokens: 1 } }),
      );
    };
    const model = gatewayModels('test-key').embedding(
      'google/gemini-embedding-2',
      { dimensions: 768, fetch: fakeFetch },
    );

    await embed({ model, value: 'đậu phụ' });

    expect(bodies[0]).toMatchObject({ values: ['đậu phụ'], dimensions: 768 });
  });

  it('builds OpenRouter models instead when AI_PROVIDER=openrouter', () => {
    vi.stubEnv('AI_PROVIDER', 'openrouter');
    const config = new ConfigService({ OPENROUTER_API_KEY: 'or-key' });
    const model = aiModels(config).chat('anthropic/claude-haiku-5.5');
    expect(model.provider).toMatch(/^openrouter/);

    vi.stubEnv('AI_PROVIDER', 'gateway');
    const gatewayConfig = new ConfigService({
      OPENROUTER_API_KEY: 'or-key',
      AI_GATEWAY_API_KEY: 'gw-key',
    });
    expect(
      aiModels(gatewayConfig).chat('anthropic/claude-haiku-5.5').provider,
    ).toBe('gateway');
  });

  it('names each provider its own image and OCR models, unless the env sets one', () => {
    const config = new ConfigService({
      AI_GATEWAY_OCR_MODEL: 'mistral/mistral-medium-3.5',
    });

    vi.stubEnv('AI_PROVIDER', 'gateway');
    expect(modelIdFor(config, 'image')).toBe('microsoft/mai-image-2.7-flash');
    expect(modelIdFor(config, 'ocr')).toBe('mistral/mistral-medium-3.5');
    expect(providerDialect().pdfReading()).toEqual({});

    vi.stubEnv('AI_PROVIDER', 'openrouter');
    expect(modelIdFor(config, 'image')).toBe('qwen/qwen-image-2.1-turbo');
    expect(modelIdFor(config, 'ocr')).toBe('mistralai/mistral-small-2603');
    expect(providerDialect().pdfReading()).toEqual({
      openrouter: {
        plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
      },
    });
  });

  it('builds Gateway reranking, transcription and image models', () => {
    const models = gatewayModels('test-key');
    expect(models.reranking('cohere/rerank-v3.5').provider).toBe('gateway');
    expect(models.transcription('elevenlabs/scribe-v2').modelId).toBe(
      'elevenlabs/scribe-v2',
    );
    expect(models.image('microsoft/mai-image-2.7-flash').modelId).toBe(
      'microsoft/mai-image-2.7-flash',
    );
  });
});
