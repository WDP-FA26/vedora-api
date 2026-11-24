import { generateText } from 'ai';
import { describe, expect, it } from 'vitest';
import { chatModel, providerOrderFrom } from '../../../src/ai/openrouter.js';

/** Sends one call through a fake fetch and returns the request body OpenRouter would get. */
async function requestBody(providerOrder?: string[]): Promise<Record<string, unknown>> {
  let body = '';
  const fakeFetch: typeof fetch = (_input, init) => {
    body = typeof init?.body === 'string' ? init.body : '';
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
  return JSON.parse(body) as Record<string, unknown>;
}

describe('providerOrderFrom', () => {
  it('reads comma-separated slugs and skips blanks', () => {
    expect(providerOrderFrom(' claude-on-aws, anthropic,,azure ')).toEqual([
      'claude-on-aws',
      'anthropic',
      'azure',
    ]);
    expect(providerOrderFrom('')).toEqual([]);
  });
});

describe('chatModel provider order', () => {
  it('asks OpenRouter for the providers in order, keeping fallbacks', async () => {
    const body = await requestBody(['claude-on-aws', 'anthropic']);
    expect(body.provider).toEqual({
      order: ['claude-on-aws', 'anthropic'],
      allow_fallbacks: true,
    });
  });

  it('leaves routing to OpenRouter without an order', async () => {
    const body = await requestBody();
    expect(body).not.toHaveProperty('provider');
  });
});
