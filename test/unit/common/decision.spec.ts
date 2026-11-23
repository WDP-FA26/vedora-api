import { APICallError, InvalidResponseDataError, RetryError } from 'ai';
import {
  decide,
  type DecisionModel,
  type DecisionPolicy,
} from '../../../src/common/decision/decision.js';

const POLICY: DecisionPolicy<'allow' | 'deny'> = {
  type: 'choice',
  instructions: 'Allow or deny',
  criteria: { allow: 'fine', deny: 'not fine' },
};

function apiError(status: number, headers: Record<string, string> = {}) {
  return new APICallError({
    message: `HTTP ${status}`,
    url: 'https://openrouter.ai/api/alpha/decisions',
    requestBodyValues: {},
    statusCode: status,
    responseHeaders: headers,
    isRetryable: status === 429 || status >= 500,
  });
}

const answer = (choice: string) => ({
  answers: { verdict: { type: 'choice' as const, choice } },
  warnings: [],
});

function modelWith(
  doEvaluate: DecisionModel['doEvaluate'],
): DecisionModel & { doEvaluate: ReturnType<typeof vi.fn> } {
  return { provider: 'test', modelId: 'jev', doEvaluate: vi.fn(doEvaluate) };
}

describe('decide', () => {
  it('sends the state as written and returns the choice', async () => {
    const model = modelWith(() => Promise.resolve(answer('allow')));
    const state = [
      { role: 'user', text: 'Xin chào' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } },
    ];

    const result = await decide(
      model,
      state,
      new AbortController().signal,
      POLICY,
    );

    expect(result).toEqual({ choice: 'allow', probabilities: undefined });
    expect(model.doEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({ state, questions: { verdict: POLICY } }),
    );
  });

  it('retries a rate limit after the wait the provider asks for', async () => {
    const model = modelWith(vi.fn());
    model.doEvaluate
      .mockRejectedValueOnce(apiError(429, { 'retry-after-ms': '0' }))
      .mockResolvedValueOnce(answer('deny'));

    const result = await decide(
      model,
      'text',
      new AbortController().signal,
      POLICY,
    );

    expect(result.choice).toBe('deny');
    expect(model.doEvaluate).toHaveBeenCalledTimes(2);
  });

  it('throws a first non-retryable error as is', async () => {
    const error = apiError(400);
    const model = modelWith(() => Promise.reject(error));

    await expect(
      decide(model, 'text', new AbortController().signal, POLICY),
    ).rejects.toBe(error);
    expect(model.doEvaluate).toHaveBeenCalledTimes(1);
  });

  it('gives up with a RetryError once the retries are spent', async () => {
    const model = modelWith(() =>
      Promise.reject(apiError(503, { 'retry-after': '0' })),
    );

    const error: unknown = await decide(
      model,
      'text',
      new AbortController().signal,
      POLICY,
    ).catch((caught: unknown) => caught);

    expect(RetryError.isInstance(error)).toBe(true);
    expect(model.doEvaluate.mock.calls.length).toBeGreaterThan(1);
  });

  it('refuses an answer outside the choices', async () => {
    const model = modelWith(() => Promise.resolve(answer('maybe')));

    await expect(
      decide(model, 'text', new AbortController().signal, POLICY),
    ).rejects.toSatisfy((error) => InvalidResponseDataError.isInstance(error));
  });

  it('does not call the model once the request is aborted', async () => {
    const abort = new AbortController();
    abort.abort(new Error('client closed'));
    const model = modelWith(() => Promise.resolve(answer('allow')));

    await expect(decide(model, 'text', abort.signal, POLICY)).rejects.toThrow(
      'client closed',
    );
    expect(model.doEvaluate).not.toHaveBeenCalled();
  });
});
