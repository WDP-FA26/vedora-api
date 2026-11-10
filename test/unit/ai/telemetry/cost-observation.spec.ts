import {
  CostObservation,
  CostResponseParser,
  costValue,
} from '../../../../src/ai/telemetry/cost-observation.js';
import { requestCostContext } from '../../../../src/ai/telemetry/ai-cost-context.js';

describe('provider billing metadata', () => {
  it('distinguishes a reported zero from an unavailable or invalid charge', () => {
    const observation = new CostObservation();
    observation.accept({ usage: {} });
    expect(observation.costUsd).toBeNull();
    observation.accept({ usage: { cost: 0 } });
    expect(observation.costUsd).toBe('0');
    for (const invalid of [-1, Infinity, NaN, '', 'NaN', '-1', null])
      expect(costValue(invalid)).toBeNull();
  });
  it('reads response API usage without double-counting reasoning or cache', () => {
    const observation = new CostObservation();
    observation.accept({
      type: 'response.completed',
      response: {
        id: 'gen-1',
        model: 'actual/model',
        usage: {
          cost: 0.03,
          input_tokens: 100,
          output_tokens: 50,
          output_tokens_details: { reasoning_tokens: 20 },
          input_tokens_details: { cached_tokens: 70 },
        },
      },
    });
    expect(observation).toMatchObject({
      generationId: 'gen-1',
      costUsd: '0.03',
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 20,
      cachedTokens: 70,
    });
  });
  it('handles arbitrary UTF8 and SSE chunk boundaries and terminal usage', () => {
    const parser = new CostResponseParser(true);
    const bytes = new TextEncoder().encode(
      'data: {"id":"gen-2","choices":[{"delta":{"content":"Món chay"}}]}\r\n\r\ndata: {"usage":{"cost":0.000123,"prompt_tokens":8,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    );
    for (const byte of bytes) parser.write(new Uint8Array([byte]));
    parser.finish();
    expect(parser.observation).toMatchObject({
      generationId: 'gen-2',
      costUsd: '0.000123',
      inputTokens: 8,
      outputTokens: 2,
    });
    expect(JSON.stringify(parser.observation)).not.toContain('Món chay');
  });
  it('skips an oversized SSE line but still reads subsequent usage', () => {
    const parser = new CostResponseParser(true);
    parser.write(
      new TextEncoder().encode('data: ' + 'x'.repeat(1024 * 1024 + 1)),
    );
    parser.write(
      new TextEncoder().encode('\n\ndata: {"usage":{"cost":0.01}}\n\n'),
    );
    parser.finish();
    expect(parser.observation.costUsd).toBe('0.01');
  });
  it('marks response errors while retaining billed usage', () => {
    const parser = new CostResponseParser(false);
    parser.write(
      new TextEncoder().encode(
        JSON.stringify({
          error: { message: 'private' },
          usage: { cost: 0.02 },
        }),
      ),
    );
    parser.finish();
    expect(parser.observation).toMatchObject({ failed: true, costUsd: '0.02' });
    expect(JSON.stringify(parser.observation)).not.toContain('private');
  });
  it('groups a blog continuation into the same scoped logical turn, not another user/session', () => {
    const context = {
      path: '/api/v1/blogs/ai/chat',
      body: { id: 'session', messages: [{ id: 'user-turn', role: 'user' }] },
      user: { sub: 'user1' },
    };
    const first = requestCostContext(context);
    const next = requestCostContext({
      ...context,
      body: {
        ...context.body,
        messages: [
          ...context.body.messages,
          { id: 'assistant', role: 'assistant' },
        ],
      },
    });
    expect(first.turnId).toBe(next.turnId);
    expect(first.executionId).not.toBe(next.executionId);
    expect(
      requestCostContext({ ...context, user: { sub: 'user2' } }).turnId,
    ).not.toBe(first.turnId);
    expect(
      requestCostContext({
        ...context,
        body: { ...context.body, id: 'another-session' },
      }).turnId,
    ).not.toBe(first.turnId);
  });
});
