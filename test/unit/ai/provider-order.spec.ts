import { generateText } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  chatModel,
  DEFAULT_MODERATION_PROVIDER_ORDER,
  DEFAULT_OPENROUTER_APP_TITLE,
  DEFAULT_OPENROUTER_APP_URL,
  providerOrderFrom,
} from '@src/ai/openrouter.js';

interface CapturedRequest {
  body: Record<string, unknown>;
  headers: Headers;
}

/** Sends one call through a fake fetch and returns the request body and headers OpenRouter would get. */
async function captureRequest(
  providerOrder?: string[],
): Promise<CapturedRequest> {
  let body = '';
  let headers = new Headers();
  const fakeFetch: typeof fetch = (input, init) => {
    body = typeof init?.body === 'string' ? init.body : '';
    headers = new Headers(
      input instanceof Request ? input.headers : init?.headers,
    );
    return Promise.resolve(
      Response.json({
        id: 'gen-1',
        model: 'anthropic/claude-haiku-5.5',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  };
  const model = chatModel({
    apiKey: 'test',
    modelId: 'anthropic/claude-haiku-5.5',
    providerOrder,
    fetch: fakeFetch,
  });
  await generateText({ model, prompt: 'hi' });
  return {
    body: JSON.parse(body) as Record<string, unknown>,
    headers,
  };
}

describe('providerOrderFrom', () => {
  it('reads comma-separated slugs and skips blanks', () => {
    expect(providerOrderFrom(' anthropic, google-vertex/global,,azure/global ')).toEqual([
      'anthropic',
      'google-vertex/global',
      'azure/global',
    ]);
    expect(providerOrderFrom(DEFAULT_MODERATION_PROVIDER_ORDER)).toEqual([
      'anthropic',
      'google-vertex/global',
      'azure/global',
    ]);
    expect(providerOrderFrom('')).toEqual([]);
  });
});

describe('chatModel provider order and attribution', () => {
  it('asks OpenRouter for the providers in order without sort, keeping fallbacks', async () => {
    const { body } = await captureRequest(['anthropic', 'google-vertex/global']);
    expect(body.provider).toEqual({
      order: ['anthropic', 'google-vertex/global'],
      allow_fallbacks: true,
    });
    expect(body.provider).not.toHaveProperty('sort');
  });

  it('leaves routing to OpenRouter without an order', async () => {
    const { body } = await captureRequest();
    expect(body).not.toHaveProperty('provider');
  });

  it('sends Vedora Platform attribution headers on requests', async () => {
    const { headers } = await captureRequest();
    expect(headers.get('HTTP-Referer')).toBe(DEFAULT_OPENROUTER_APP_URL);
    expect(headers.get('X-OpenRouter-Title')).toBe(DEFAULT_OPENROUTER_APP_TITLE);
  });
});
