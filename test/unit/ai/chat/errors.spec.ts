import { AiModelError } from '@nestjs/ai';
import { APICallError, RetryError } from 'ai';
import { chatErrorCode, failedStatus } from '@src/ai/chat/errors.js';

describe('AI chat errors', () => {
  const callError = (statusCode: number) =>
    new APICallError({
      message: 'Provider returned error',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      requestBodyValues: {},
      statusCode,
    });

  it('reports a rate limit even after the SDK gave up retrying', () => {
    const error = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [callError(429), callError(429)],
    });

    expect(chatErrorCode(error)).toBe('RATE_LIMITED');
    expect(failedStatus(error)).toBe(429);
  });

  it('unwraps AiModelError causes for both chatErrorCode and failedStatus', () => {
    const wrappedRateLimit = new AiModelError([
      {
        model: { provider: 'openrouter', modelId: 'm' },
        attempt: 1,
        error: callError(429),
      },
    ]);
    const wrappedUpstream = new AiModelError([
      {
        model: { provider: 'openrouter', modelId: 'm' },
        attempt: 1,
        error: new RetryError({
          message: 'Failed',
          reason: 'maxRetriesExceeded',
          errors: [callError(502)],
        }),
      },
    ]);

    expect(chatErrorCode(wrappedRateLimit)).toBe('RATE_LIMITED');
    expect(failedStatus(wrappedRateLimit)).toBe(429);
    expect(chatErrorCode(wrappedUpstream)).toBe('MODEL_ERROR');
    expect(failedStatus(wrappedUpstream)).toBe(502);
  });

  it('hides every other failure behind MODEL_ERROR and returns undefined status when absent', () => {
    expect(chatErrorCode(callError(500))).toBe('MODEL_ERROR');
    expect(failedStatus(callError(500))).toBe(500);
    expect(chatErrorCode(new Error('boom'))).toBe('MODEL_ERROR');
    expect(failedStatus(new Error('boom'))).toBeUndefined();
  });
});
