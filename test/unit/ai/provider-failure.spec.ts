import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiFailure, aiService } from '@src/ai/provider-failure.js';
import { ExternalServiceException } from '@src/common/exceptions/external-service.exception.js';

describe('aiFailure', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('names the provider in use', () => {
    vi.stubEnv('AI_PROVIDER', 'gateway');
    expect(aiService()).toBe('ai-gateway');
    expect(aiFailure('OCR', new Error('timeout'))).toMatchObject({
      service: 'ai-gateway',
      reason: 'OCR failed: timeout',
    });
    vi.stubEnv('AI_PROVIDER', 'openrouter');
    expect(aiFailure('Rerank', 'socket hang up')).toMatchObject({
      service: 'openrouter',
      reason: 'Rerank failed: socket hang up',
    });
  });

  it('returns an existing ExternalServiceException unchanged', () => {
    const existing = new ExternalServiceException('qdrant', 'already wrapped');
    expect(aiFailure('Rerank', existing)).toBe(existing);
  });
});
