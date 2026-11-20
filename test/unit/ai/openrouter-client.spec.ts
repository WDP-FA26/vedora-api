import { OpenRouterError } from '@openrouter/sdk/models/errors';
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
