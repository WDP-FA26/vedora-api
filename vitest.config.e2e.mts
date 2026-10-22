import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    globals: true,
    root: './',
    // Fixed config so e2e runs never depend on a developer's .env. Prisma is
    // mocked in the specs, so the database URL is never dialled.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://vedora:vedora@localhost:5432/vedora_test',
      JWT_SECRET: 'e2e-secret-that-is-at-least-32-characters',
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      CLOUDINARY_CLOUD_NAME: 'e2e-cloud',
      CLOUDINARY_API_KEY: 'e2e-api-key',
      CLOUDINARY_API_SECRET: 'e2e-api-secret',
      CLOUDINARY_WEBHOOKS_ENABLED: 'true',
      CAPTIONS_ENABLED: 'false',
      RESEND_API_KEY: '',
      OPENROUTER_API_KEY: 'e2e-openrouter-key',
      QDRANT_URL: 'http://localhost:6333',
      // Without an endpoint the API skips RustFS setup; webhooks only need
      // the token.
      STORAGE_WEBHOOK_TOKEN: 'e2e-storage-webhook-token',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      GOOGLE_CALLBACK_URL: '',
    },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
