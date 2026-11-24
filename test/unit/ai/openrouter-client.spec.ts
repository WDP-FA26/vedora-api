import { OpenRouterError } from '@openrouter/sdk/models/errors';
import { OpenRouterCacheControl } from '../../../src/ai/openrouter.js';
import {
  createOpenRouterClient,
  openRouterFailure,
} from '../../../src/ai/openrouter-client.js';
import { ExternalServiceException } from '../../../src/common/exceptions/external-service.exception.js';

describe('openrouter-client', () => {
  it('creates a client with a custom fetcher when provided and without one when omitted', async () => {
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
  });

  it('returns an existing ExternalServiceException unchanged', () => {
    const existing = new ExternalServiceException(
      'openrouter',
      'already wrapped',
    );
    expect(openRouterFailure('Rerank', existing)).toBe(existing);
  });

  it('wraps OpenRouterError with HTTP status code and message', () => {
    const response = new Response('{"error":"rate limited"}', {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
    const request = new Request('https://openrouter.ai/api/v1/rerank');
    const sdkError = new OpenRouterError('Too many requests', {
      response,
      request,
      body: '{"error":"rate limited"}',
    });

    const wrapped = openRouterFailure('Rerank', sdkError);
    expect(wrapped).toBeInstanceOf(ExternalServiceException);
    expect(wrapped).toMatchObject({
      message: 'openrouter request failed',
      reason: 'Rerank failed (429): Too many requests',
      cause: sdkError,
    });
  });

  it('wraps generic Error and non-Error throwables cleanly', () => {
    const fromError = openRouterFailure('Embeddings', new Error('timeout'));
    expect(fromError).toBeInstanceOf(ExternalServiceException);
    expect(fromError).toMatchObject({
      message: 'openrouter request failed',
      reason: 'Embeddings failed: timeout',
    });

    const fromPrimitive = openRouterFailure('OCR', 'socket hang up');
    expect(fromPrimitive).toBeInstanceOf(ExternalServiceException);
    expect(fromPrimitive).toMatchObject({
      message: 'openrouter request failed',
      reason: 'OCR failed: socket hang up',
    });
  });
});

describe('OpenRouterCacheControl', () => {
  it('builds ephemeral specs, system messages, text parts, and prefix messages', () => {
    expect(OpenRouterCacheControl.ephemeral()).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    expect(OpenRouterCacheControl.ephemeral('5m')).toEqual({
      type: 'ephemeral',
    });
    expect(OpenRouterCacheControl.system('SYSTEM')).toEqual({
      role: 'system',
      content: 'SYSTEM',
      providerOptions: {
        openrouter: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
      },
    });
    expect(OpenRouterCacheControl.system('SYSTEM', '5m')).toEqual({
      role: 'system',
      content: 'SYSTEM',
      providerOptions: {
        openrouter: { cacheControl: { type: 'ephemeral' } },
      },
    });
    expect(OpenRouterCacheControl.textPart('<catalog/>')).toEqual({
      type: 'text',
      text: '<catalog/>',
      providerOptions: {
        openrouter: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
      },
    });
    expect(
      OpenRouterCacheControl.prefixMessages('<catalog/>', '<source/>', '5m'),
    ).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<catalog/>',
            providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } },
          },
          { type: 'text', text: '<source/>' },
        ],
      },
    ]);
  });

  it('hashes scope into opaque 256-char-bounded session IDs and composes singleTurn / agent options', () => {
    const first = OpenRouterCacheControl.sessionId(
      'vedora-planner',
      'user-123',
      'thread-456',
    );
    const second = OpenRouterCacheControl.sessionId(
      'vedora-planner',
      'user-123',
      'thread-456',
    );
    const different = OpenRouterCacheControl.sessionId(
      'vedora-planner',
      'user-123',
      'thread-789',
    );

    expect(first).toBe(second);
    expect(first).not.toBe(different);
    expect(first).toMatch(/^vedora-planner-[a-f0-9]{24}$/);
    expect(first).not.toContain('user-123');
    expect(first).not.toContain('thread-456');
    expect(
      OpenRouterCacheControl.sessionId('vedora-static', undefined, ''),
    ).toBe('vedora-static');

    const longId = 'a'.repeat(300);
    expect(
      OpenRouterCacheControl.sticky(longId).openrouter.session_id,
    ).toHaveLength(256);

    expect(
      OpenRouterCacheControl.singleTurn({
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
      OpenRouterCacheControl.singleTurn({
        session: 'vedora-mod',
        instructions: 'DRAFT',
        enabled: false,
      }),
    ).toEqual({
      instructions: 'DRAFT',
      providerOptions: { openrouter: { session_id: 'vedora-mod' } },
    });

    const agentOpts = OpenRouterCacheControl.agent({
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
      OpenRouterCacheControl.withUserContext(
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
      OpenRouterCacheControl.withUserContext(
        [{ role: 'user', content: 'hi' }],
        '<ctx/>',
      ),
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
      OpenRouterCacheControl.withUserContext(
        [{ role: 'assistant', content: 'hello' }],
        '<ctx/>',
      ),
    ).toEqual([{ role: 'assistant', content: 'hello' }]);

    const withReminder = OpenRouterCacheControl.finalStepGuard(3, ' Wrap up ');
    expect(withReminder({ stepNumber: 1, messages: [] })).toEqual({});
    expect(
      withReminder({ stepNumber: 2, messages: [{ role: 'user', content: 'q' }] }),
    ).toEqual({
      toolChoice: 'none',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'user', content: '<system-reminder>Wrap up</system-reminder>' },
      ],
    });

    const plainGuard = OpenRouterCacheControl.finalStepGuard(3);
    expect(plainGuard({ stepNumber: 2, messages: [] })).toEqual({
      toolChoice: 'none',
    });
  });
});
