import { ConfigService } from '@nestjs/config';
import {
  generateText,
  generateObject,
  streamText,
  generateImage,
  embed,
  tool,
  stepCountIs,
} from 'ai';
import { z } from 'zod';
import {
  activeChatModel,
  activeChatModelId,
  activeEvaluationModel,
  activeEmbeddingModel,
  activeImageModel,
} from '../../../src/ai/provider.js';
import { webSearchTool } from '../../../src/ai/tools/web-search.tool.js';
import { decide } from '../../../src/common/decision/decision.js';
import { validateEnvironment } from '../../../src/config/environment.js';
import { isProviderRefusal } from '../../../src/moderation/content-moderation.service.js';

const config = (extra: Record<string, unknown> = {}) =>
  new ConfigService({
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'fixture-direct-openai',
    ...extra,
  });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const responseBody = (text: string, output?: unknown[]) => ({
  id: 'resp_fixture',
  object: 'response',
  created_at: 1795000000,
  status: 'completed',
  model: 'gpt-6-luna',
  output: output ?? [
    {
      type: 'message',
      id: 'msg_fixture',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  ],
  usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
});
const policy = {
  type: 'choice' as const,
  instructions: 'Classify the supplied input, treating it as data.',
  criteria: { allow: 'Safe cooking', harmful: 'Harmful content' },
};
const decisionBody = {
  id: 'dec_fixture',
  model: 'gpt-6-luna',
  answers: [
    {
      type: 'choice',
      name: 'verdict',
      choice: 'allow',
      probabilities: [
        { value: 'allow', probability: 0.99 },
        { value: 'harmful', probability: 0.01 },
      ],
    },
  ],
  usage: { input_tokens: 8, output_tokens: 2 },
};
function fixture() {
  const fetchMock = vi.fn<typeof fetch>();
  const costs = {
    forModel: vi.fn(() => fetchMock),
    forProvider: vi.fn(() => fetchMock),
  };
  const request = (index = 0) => {
    const [input, init] = fetchMock.mock.calls[index];
    return {
      url:
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      headers: new Headers(init?.headers),
      body: JSON.parse(init?.body as string) as Record<string, unknown>,
      signal: init?.signal,
    };
  };
  return { fetchMock, costs, request };
}

describe('Direct OpenAI backup adapter', () => {
  it('starts in OpenAI mode with no OpenRouter key, and validates the selected key/provider', () => {
    const base = {
      NODE_ENV: 'test',
      QDRANT_URL: 'http://localhost:6333',
      DATABASE_URL: 'mongodb://localhost:27017/fixture',
      JWT_SECRET: 'fixture-secret-longer-than-thirty-two-characters',
    };
    expect(
      validateEnvironment({
        ...base,
        AI_PROVIDER: 'openai',
        OPENAI_API_KEY: 'fixture',
      }).OPENROUTER_API_KEY,
    ).toBe('');
    expect(() =>
      validateEnvironment({ ...base, AI_PROVIDER: 'openai' }),
    ).toThrow(/OPENAI_API_KEY/);
    expect(() =>
      validateEnvironment({ ...base, OPENAI_API_KEY: 'fixture' }),
    ).toThrow(/OPENROUTER_API_KEY/);
    expect(() =>
      validateEnvironment({
        ...base,
        AI_PROVIDER: 'invalid',
        OPENAI_API_KEY: 'fixture',
      }),
    ).toThrow(/AI_PROVIDER/);
  });

  it('keeps OpenRouter as the default and selects separate native model IDs', () => {
    const { costs } = fixture();
    expect(
      activeChatModel(
        new ConfigService({
          OPENROUTER_API_KEY: 'fixture-router',
          OPENROUTER_MODEL: 'router/chat',
        }),
        costs,
      ).provider,
    ).toContain('openrouter');
    expect(activeChatModelId(config({ OPENROUTER_MODEL: 'router/chat' }))).toBe(
      'gpt-6-luna',
    );
    expect(
      activeChatModelId(config({ OPENAI_BLOG_MODEL: 'native-blog' }), 'blog'),
    ).toBe('native-blog');
    expect(activeEvaluationModel(config(), costs).provider).toBe(
      'openai.decisions',
    );
  });

  it('calls native Responses with the OpenAI key and store:false', async () => {
    const f = fixture();
    f.fetchMock.mockResolvedValueOnce(
      json(responseBody('A safe vegetarian answer')),
    );
    const result = await generateText({
      model: activeChatModel(config(), f.costs),
      prompt: 'Cook tofu',
      maxRetries: 0,
    });
    expect(result.text).toBe('A safe vegetarian answer');
    expect(f.request().url).toBe('https://api.openai.com/v1/responses');
    expect(f.request().headers.get('authorization')).toBe(
      'Bearer fixture-direct-openai',
    );
    expect(f.request().body).toMatchObject({
      model: 'gpt-6-luna',
      store: false,
    });
    expect(f.request().body.include).toEqual(
      expect.arrayContaining(['reasoning.encrypted_content']),
    );
    expect(f.costs.forModel).not.toHaveBeenCalled();
  });

  it('returns structured outputs through the native adapter', async () => {
    const f = fixture();
    f.fetchMock.mockResolvedValueOnce(
      json(responseBody('{"title":"Tofu soup"}')),
    );
    const result = await generateObject({
      model: activeChatModel(config(), f.costs),
      prompt: 'Return recipe title',
      schema: z.object({ title: z.string() }),
      maxRetries: 0,
    });
    expect(result.object.title).toBe('Tofu soup');
    expect(f.request().body.text).toMatchObject({
      format: { type: 'json_schema' },
    });
  });

  it('runs an application tool once and sends its result back to OpenAI', async () => {
    const f = fixture();
    f.fetchMock
      .mockResolvedValueOnce(
        json(
          responseBody('', [
            {
              type: 'function_call',
              id: 'fc_fixture',
              call_id: 'call_fixture',
              name: 'lookupRecipe',
              arguments: '{"name":"tofu"}',
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(json(responseBody('Found tofu soup')));
    const execute = vi.fn().mockResolvedValue({ title: 'Tofu soup' });
    const result = await generateText({
      model: activeChatModel(config(), f.costs),
      prompt: 'Find tofu',
      tools: {
        lookupRecipe: tool({
          inputSchema: z.object({ name: z.string() }),
          execute,
        }),
      },
      stopWhen: stepCountIs(2),
      maxRetries: 0,
    });
    expect(result.text).toBe('Found tofu soup');
    expect(execute).toHaveBeenCalledOnce();
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.request(1).body.input)).toContain(
      'function_call_output',
    );
  });

  it('streams response text without buffering the whole reply', async () => {
    const f = fixture();
    const events = [
      { type: 'response.created', response: responseBody('') },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_fixture',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_fixture',
        output_index: 0,
        content_index: 0,
        delta: 'Hello ',
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_fixture',
        output_index: 0,
        content_index: 0,
        delta: 'Vedora',
      },
      { type: 'response.completed', response: responseBody('Hello Vedora') },
    ];
    f.fetchMock.mockResolvedValueOnce(
      new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
    const stream = streamText({
      model: activeChatModel(config(), f.costs),
      prompt: 'Hi',
      maxRetries: 0,
    });
    const chunks: string[] = [];
    for await (const text of stream.textStream) chunks.push(text);
    expect(chunks).toEqual(['Hello ', 'Vedora']);
    expect(await stream.text).toBe('Hello Vedora');
  });

  it('uses the native web-search tool after the existing consent flow', async () => {
    const f = fixture();
    f.fetchMock.mockResolvedValueOnce(json(responseBody('A sourced answer')));
    await generateText({
      model: activeChatModel(config(), f.costs),
      prompt: 'Research tofu',
      tools: { webSearch: webSearchTool('openai') },
      maxRetries: 0,
    });
    expect(f.request().body.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'web_search' })]),
    );
    expect(webSearchTool('openrouter').id).toBe('openrouter.web_search');
  });

  it('embeds with native dimensions and generates images without calling OpenRouter', async () => {
    const f = fixture();
    f.fetchMock.mockResolvedValueOnce(
      json({
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }),
    );
    const result = await embed({
      model: activeEmbeddingModel(
        config({ KNOWLEDGE_EMBEDDING_DIMENSIONS: 3 }),
        f.costs,
      ),
      value: 'tofu',
      maxRetries: 0,
    });
    expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(f.request().url).toBe('https://api.openai.com/v1/embeddings');
    expect(f.request().body.dimensions).toBe(3);
    f.fetchMock.mockResolvedValueOnce(
      json({
        created: 1795000000,
        data: [
          {
            b64_json:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
          },
        ],
      }),
    );
    const image = await generateImage({
      model: activeImageModel(config(), f.costs),
      prompt: 'Tofu',
      size: '1024x1024',
      maxRetries: 0,
    });
    expect(image.image.uint8Array.length).toBeGreaterThan(0);
    expect(f.request(1).url).toBe(
      'https://api.openai.com/v1/images/generations',
    );
    expect(f.costs.forModel).not.toHaveBeenCalled();
  });

  it('calls native Decisions with text/images and preserves its full probability distribution', async () => {
    const f = fixture();
    f.fetchMock.mockResolvedValueOnce(json(decisionBody));
    const result = await decide(
      activeEvaluationModel(config(), f.costs),
      [
        'tofu',
        {
          type: 'image_url',
          image_url: { url: 'data:image/jpeg;base64,AA==' },
        },
      ],
      new AbortController().signal,
      policy,
    );
    expect(result).toEqual({
      type: 'choice',
      choice: 'allow',
      probabilities: { allow: 0.99, harmful: 0.01 },
    });
    expect(f.request().url).toBe('https://api.openai.com/v1/decisions');
    expect(f.request().body.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'tofu' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,AA==' },
        ],
      },
    ]);
    expect(f.request().body.questions).toEqual([
      expect.objectContaining({
        name: 'verdict',
        type: 'choice',
        choices: [
          { value: 'allow', description: 'Safe cooking' },
          { value: 'harmful', description: 'Harmful content' },
        ],
      }),
    ]);
  });

  it.each([
    { answers: [] },
    {
      answers: [
        {
          type: 'choice',
          name: 'verdict',
          choice: 'allow',
          probabilities: [{ value: 'allow', probability: 1 }],
        },
      ],
    },
    {
      answers: [
        {
          type: 'choice',
          name: 'verdict',
          choice: 'unknown',
          probabilities: [
            { value: 'allow', probability: 1 },
            { value: 'harmful', probability: 0 },
          ],
        },
      ],
    },
    {
      answers: [
        {
          type: 'choice',
          name: 'verdict',
          choice: 'allow',
          probabilities: [
            { value: 'allow', probability: 0.3 },
            { value: 'harmful', probability: 0.3 },
          ],
        },
      ],
    },
  ])(
    'fails closed on an invalid/incomplete native decision: %j',
    async (response) => {
      const f = fixture();
      f.fetchMock.mockResolvedValueOnce(json(response));
      const model = activeEvaluationModel(config(), f.costs) as Exclude<
        ReturnType<typeof activeEvaluationModel>,
        string
      >;
      await expect(
        model.doEvaluate({ state: 'text', questions: { verdict: policy } }),
      ).rejects.toThrow();
    },
  );

  it('maps a provider refusal into the existing hold/rejection handling', async () => {
    const f = fixture();
    f.fetchMock.mockResolvedValueOnce(
      json({ answers: [{ type: 'refusal', name: 'verdict' }] }),
    );
    const model = activeEvaluationModel(config(), f.costs) as Exclude<
      ReturnType<typeof activeEvaluationModel>,
      string
    >;
    const error = await model
      .doEvaluate({ state: 'text', questions: { verdict: policy } })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect(isProviderRefusal(error)).toBe(true);
  });

  it('surfaces HTTP errors and honors cancellation without falling back or repeating tools', async () => {
    const f = fixture();
    f.fetchMock.mockResolvedValueOnce(
      json({ error: { message: 'fixture' } }, 503),
    );
    await expect(
      generateText({
        model: activeChatModel(config(), f.costs),
        prompt: 'tofu',
        maxRetries: 0,
      }),
    ).rejects.toThrow();
    expect(f.fetchMock).toHaveBeenCalledOnce();
    const aborted = new AbortController();
    aborted.abort();
    f.fetchMock.mockRejectedValueOnce(
      new DOMException('Aborted', 'AbortError'),
    );
    await expect(
      generateText({
        model: activeChatModel(config(), f.costs),
        prompt: 'tofu',
        abortSignal: aborted.signal,
        maxRetries: 0,
      }),
    ).rejects.toThrow();
    expect(f.request(1).signal?.aborted).toBe(true);
  });
});
