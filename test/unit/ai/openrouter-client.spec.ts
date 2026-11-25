import {
  DEFAULT_AI_APP_TITLE,
  DEFAULT_AI_APP_URL,
  aiAppAttribution,
  ephemeralCache,
} from '@src/ai/providers/provider-shared.js';
import { PromptCache } from '@src/ai/prompt-cache.js';
import { createOpenRouterClient } from '@src/ai/providers/openrouter/openrouter.client.js';

describe('openrouter-client', () => {
  it('creates a client with a custom fetcher when provided and attaches attribution headers', async () => {
    const plain = createOpenRouterClient('test-key');
    expect(plain).toBeDefined();

    const customFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        model: 'cohere/rerank-v3.5',
        results: [{ index: 0, relevance_score: 0.9, document: { text: 'a' } }],
      }),
    );
    const instrumented = createOpenRouterClient('test-key', customFetch);
    await instrumented.rerank.rerank({
      requestBody: {
        model: 'cohere/rerank-v3.5',
        query: 'q',
        documents: ['a'],
        topN: 1,
      },
    });
    expect(customFetch).toHaveBeenCalledOnce();
    const [request] = customFetch.mock.calls[0];
    expect(request).toBeInstanceOf(Request);
    const headers =
      request instanceof Request ? request.headers : new Headers();
    expect(headers.get('HTTP-Referer')).toBe(DEFAULT_AI_APP_URL);
    expect(headers.get('X-OpenRouter-Title')).toBe(DEFAULT_AI_APP_TITLE);
  });

  it('resolves attribution defaults and env overrides', () => {
    const prevUrl = process.env.AI_APP_URL;
    const prevTitle = process.env.AI_APP_TITLE;
    try {
      delete process.env.AI_APP_URL;
      delete process.env.AI_APP_TITLE;
      expect(aiAppAttribution()).toEqual({
        appUrl: DEFAULT_AI_APP_URL,
        appTitle: DEFAULT_AI_APP_TITLE,
      });

      process.env.AI_APP_URL = ' https://custom.vedora.test ';
      process.env.AI_APP_TITLE = ' Custom Vedora ';
      expect(aiAppAttribution()).toEqual({
        appUrl: 'https://custom.vedora.test',
        appTitle: 'Custom Vedora',
      });
    } finally {
      if (prevUrl === undefined) delete process.env.AI_APP_URL;
      else process.env.AI_APP_URL = prevUrl;
      if (prevTitle === undefined) delete process.env.AI_APP_TITLE;
      else process.env.AI_APP_TITLE = prevTitle;
    }
  });
});

describe('PromptCache with the OpenRouter dialect', () => {
  it('builds ephemeral specs, system messages, text parts, and prefix messages', () => {
    expect(ephemeralCache()).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    expect(ephemeralCache('5m')).toEqual({
      type: 'ephemeral',
    });
    expect(PromptCache.system('SYSTEM')).toEqual({
      role: 'system',
      content: 'SYSTEM',
      providerOptions: {
        openrouter: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
      },
    });
    expect(PromptCache.system('SYSTEM', '5m')).toEqual({
      role: 'system',
      content: 'SYSTEM',
      providerOptions: {
        openrouter: { cacheControl: { type: 'ephemeral' } },
      },
    });
    expect(PromptCache.textPart('<catalog/>')).toEqual({
      type: 'text',
      text: '<catalog/>',
      providerOptions: {
        openrouter: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
      },
    });
    expect(PromptCache.prefixMessages('<catalog/>', '<source/>', '5m')).toEqual(
      [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<catalog/>',
              providerOptions: {
                openrouter: { cacheControl: { type: 'ephemeral' } },
              },
            },
            { type: 'text', text: '<source/>' },
          ],
        },
      ],
    );
  });

  it('hashes scope into opaque 256-char-bounded session IDs and composes singleTurn / agent options', () => {
    const first = PromptCache.sessionId(
      'vedora-planner',
      'user-123',
      'thread-456',
    );
    const second = PromptCache.sessionId(
      'vedora-planner',
      'user-123',
      'thread-456',
    );
    const different = PromptCache.sessionId(
      'vedora-planner',
      'user-123',
      'thread-789',
    );

    expect(first).toBe(second);
    expect(first).not.toBe(different);
    expect(first).toMatch(/^vedora-planner-[a-f0-9]{24}$/);
    expect(first).not.toContain('user-123');
    expect(first).not.toContain('thread-456');
    expect(PromptCache.sessionId('vedora-static', undefined, '')).toBe(
      'vedora-static',
    );

    const longId = 'a'.repeat(300);
    expect(PromptCache.sticky(longId).openrouter.session_id).toHaveLength(256);

    expect(
      PromptCache.singleTurn({
        session: 'vedora-mod',
        instructions: 'POLICY',
      }),
    ).toEqual({
      instructions: {
        role: 'system',
        content: 'POLICY',
        providerOptions: {
          openrouter: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
        },
      },
      providerOptions: { openrouter: { session_id: 'vedora-mod' } },
    });

    expect(
      PromptCache.singleTurn({
        session: 'vedora-mod',
        instructions: 'DRAFT',
        enabled: false,
      }),
    ).toEqual({
      instructions: 'DRAFT',
      providerOptions: { openrouter: { session_id: 'vedora-mod' } },
    });

    const agentOpts = PromptCache.agent({
      session: 'vedora-blog',
      scope: ['u1', 'b1'],
      instructions: 'RULES',
    });
    expect(agentOpts.instructions).toEqual({
      role: 'system',
      content: 'RULES',
      providerOptions: {
        openrouter: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
      },
    });
    expect(agentOpts.providerOptions.openrouter.cacheControl).toEqual({
      type: 'ephemeral',
    });
    expect(agentOpts.providerOptions.openrouter.session_id).toMatch(
      /^vedora-blog-[a-f0-9]{24}$/,
    );
  });

  it('injects dynamic context into the last user message and guards final steps', () => {
    expect(
      PromptCache.withUserContext(
        [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: [{ type: 'text', text: 'second' }] },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'c1',
                toolName: 'edit',
                output: { type: 'json', value: { ok: true } },
              },
            ],
          },
        ],
        '<ctx/>',
      ),
    ).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '<ctx/>' },
          { type: 'text', text: 'second' },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'edit',
            output: { type: 'json', value: { ok: true } },
          },
        ],
      },
    ]);

    expect(
      PromptCache.withUserContext([{ role: 'user', content: 'hi' }], '<ctx/>'),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '<ctx/>' },
          { type: 'text', text: 'hi' },
        ],
      },
    ]);

    expect(
      PromptCache.withUserContext(
        [{ role: 'assistant', content: 'hello' }],
        '<ctx/>',
      ),
    ).toEqual([{ role: 'assistant', content: 'hello' }]);

    const withReminder = PromptCache.finalStepGuard(3, ' Wrap up ');
    expect(withReminder({ stepNumber: 1, messages: [] })).toEqual({});
    expect(
      withReminder({
        stepNumber: 2,
        messages: [{ role: 'user', content: 'q' }],
      }),
    ).toEqual({
      toolChoice: 'none',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'user', content: '<system-reminder>Wrap up</system-reminder>' },
      ],
    });

    const plainGuard = PromptCache.finalStepGuard(3);
    expect(plainGuard({ stepNumber: 2, messages: [] })).toEqual({
      toolChoice: 'none',
    });
  });
});
