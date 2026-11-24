import 'reflect-metadata';
import { validateEnvironment } from '@src/config/environment.js';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'mongodb://localhost:27017/vedora',
  JWT_SECRET: 'x'.repeat(32),
  OPENROUTER_API_KEY: 'test-key',
  QDRANT_URL: 'http://localhost:6333',
};

describe('validateEnvironment conditional branches', () => {
  it('parses boolean env strings and defaults properly', () => {
    const env = validateEnvironment({
      ...base,
      CLOUDINARY_WEBHOOKS_ENABLED: true,
      CAPTIONS_ENABLED: '0',
      SEPAY_PAYMENT_ENABLED: '1',
      SEPAY_QR_BANK_CODE: 'VCB',
      SEPAY_BANK_GATEWAY: 'Vietcombank',
      SEPAY_QR_ACCOUNT_NUMBER: '0123456789',
      SEPAY_QR_ACCOUNT_HOLDER: 'VEDORA',
      SEPAY_QR_TRANSFER_PREFIX: 'VED',
      SEPAY_BANK_WEBHOOK_API_KEY: 'a'.repeat(16),
      STORAGE_ENDPOINT: 'http://localhost:9000',
      STORAGE_PUBLIC_URL: 'http://localhost:9000',
      GOOGLE_CALLBACK_URL: 'http://localhost:3000/auth/google',
    });
    expect(env.CLOUDINARY_WEBHOOKS_ENABLED).toBe(true);
    expect(env.CAPTIONS_ENABLED).toBe(false);
    expect(env.SEPAY_PAYMENT_ENABLED).toBe(true);

    const envFalse = validateEnvironment({
      ...base,
      CAPTIONS_ENABLED: 'false',
      CLOUDINARY_WEBHOOKS_ENABLED: '',
    });
    expect(envFalse.CAPTIONS_ENABLED).toBe(false);
    expect(envFalse.CLOUDINARY_WEBHOOKS_ENABLED).toBe(false);

    expect(() =>
      validateEnvironment({ ...base, CAPTIONS_ENABLED: 'maybe' }),
    ).toThrow(/CAPTIONS_ENABLED/);
  });

  it('requires RESEND_API_KEY and TURNSTILE_SECRET_KEY in production', () => {
    expect(() =>
      validateEnvironment({
        ...base,
        NODE_ENV: 'production',
        RESEND_API_KEY: '',
        TURNSTILE_SECRET_KEY: '',
      }),
    ).toThrow(/Config validation error/);

    const prod = validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      RESEND_API_KEY: 're_prod_key',
      TURNSTILE_SECRET_KEY: 'turnstile-prod-secret',
    });
    expect(prod.RESEND_API_KEY).toBe('re_prod_key');
    expect(prod.TURNSTILE_SECRET_KEY).toBe('turnstile-prod-secret');
  });

  it('rejects partial SePay config when SEPAY_PAYMENT_ENABLED is true', () => {
    expect(() =>
      validateEnvironment({
        ...base,
        SEPAY_PAYMENT_ENABLED: 'true',
        SEPAY_BANK_WEBHOOK_API_KEY: 'short',
      }),
    ).toThrow(/Config validation error/);
  });
});
