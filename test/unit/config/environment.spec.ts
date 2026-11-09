import 'reflect-metadata';
import { validateEnvironment } from '../../../src/config/environment.js';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'mongodb://localhost:27017/vedora',
  JWT_SECRET: 'x'.repeat(32),
  OPENROUTER_API_KEY: 'test-key',
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
