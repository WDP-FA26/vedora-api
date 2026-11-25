import 'reflect-metadata';
import { validateEnvironment } from '@src/config/environment.js';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'mongodb://localhost:27017/vedora',
  JWT_SECRET: 'x'.repeat(32),
  OPENROUTER_API_KEY: 'test-key',
  AI_GATEWAY_API_KEY: 'test-gateway-key',
  QDRANT_URL: 'http://localhost:6333',
};

describe('validateEnvironment: PAYMENT_REDIS_URL', () => {
  it('accepts the Compose service hostname, which has no TLD', () => {
    expect(() =>
      validateEnvironment({ ...base, PAYMENT_REDIS_URL: 'redis://redis:6379' }),
    ).not.toThrow();
  });

  it('still rejects a value that is not a redis URL', () => {
    expect(() =>
      validateEnvironment({ ...base, PAYMENT_REDIS_URL: 'not a url' }),
    ).toThrow(/PAYMENT_REDIS_URL/);
  });
});

describe('validateEnvironment: AI_PROVIDER', () => {
  const { AI_GATEWAY_API_KEY: _key, ...withoutGatewayKey } = base;

  it('defaults to the Gateway and requires its key', () => {
    expect(validateEnvironment(base).AI_PROVIDER).toBe('gateway');
    expect(() => validateEnvironment(withoutGatewayKey)).toThrow(
      /AI_GATEWAY_API_KEY/,
    );
  });

  it('requires both AI_GATEWAY_API_KEY and OPENROUTER_API_KEY regardless of AI_PROVIDER', () => {
    const { OPENROUTER_API_KEY: _orKey, ...withoutOpenRouterKey } = base;
    expect(validateEnvironment(base).AI_PROVIDER).toBe('gateway');
    expect(() => validateEnvironment(withoutGatewayKey)).toThrow(
      /AI_GATEWAY_API_KEY/,
    );
    expect(() =>
      validateEnvironment({ ...withoutGatewayKey, AI_PROVIDER: 'openrouter' }),
    ).toThrow(/AI_GATEWAY_API_KEY/);
    expect(() => validateEnvironment(withoutOpenRouterKey)).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it('rejects an unknown provider', () => {
    expect(() =>
      validateEnvironment({ ...base, AI_PROVIDER: 'other' }),
    ).toThrow(/AI_PROVIDER/);
  });
});
