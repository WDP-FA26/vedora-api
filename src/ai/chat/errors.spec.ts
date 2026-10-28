import { APICallError, RetryError } from 'ai';
import { chatErrorCode } from './errors.js';

describe('chatErrorCode', () => {
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
  });

  it('hides every other failure behind MODEL_ERROR', () => {
    expect(chatErrorCode(callError(500))).toBe('MODEL_ERROR');
    expect(chatErrorCode(new Error('boom'))).toBe('MODEL_ERROR');
  });
});
