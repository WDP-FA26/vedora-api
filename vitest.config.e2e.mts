import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e-spec.ts'],
    globals: true,
    root: './',
    // Each spec creates its own database and indexes, which takes seconds; a
    // few at a time keeps MongoDB from starving.
    globalSetup: ['test/support/global-setup.ts'],
    hookTimeout: 60_000,
    // Vitest's 5s default is too tight: under 4 workers a request-heavy test
    // (concurrency races, background indexing that waits up to 10s) sometimes
    // takes 5-10s and then fails intermittently. Same budget as unit/db.
    testTimeout: 15_000,
    maxWorkers: 4,
    // Fixed config so e2e runs never depend on a developer's .env. The specs
    // use databases of their own (see test/mongo-test-db.ts).
    env: {
      NODE_ENV: 'test',
      DATABASE_URL:
        'mongodb://localhost:27017/vedora_test?directConnection=true',
      JWT_SECRET: 'e2e-secret-that-is-at-least-32-characters',
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      CLOUDINARY_CLOUD_NAME: 'e2e-cloud',
      CLOUDINARY_API_KEY: 'e2e-api-key',
      CLOUDINARY_API_SECRET: 'e2e-api-secret',
      CLOUDINARY_WEBHOOKS_ENABLED: 'true',
      CAPTIONS_ENABLED: 'false',
      POST_SUMMARIES_ENABLED: 'false',
      RESEND_API_KEY: '',
      OPENROUTER_API_KEY: 'e2e-openrouter-key',
      AI_GATEWAY_API_KEY: 'e2e-gateway-key',
      AI_PROVIDER: 'openrouter',
      QDRANT_URL: 'http://localhost:6333',
      STORAGE_ENDPOINT: 'http://localhost:9000',
      STORAGE_PUBLIC_URL: 'http://localhost:9000',
      FRONTEND_URL: 'http://localhost:3000',
      // Without an endpoint the API skips RustFS setup; webhooks only need
      // the token.
      STORAGE_WEBHOOK_TOKEN: 'e2e-storage-webhook-token',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      GOOGLE_CALLBACK_URL: '',
    },
  },
  // https://docs.nestjs.com/recipes/swc#path-aliases — Vitest does not read
  // tsconfig "paths"; keep these in sync with tsconfig.json.
  resolve: {
    alias: {
      '@src': resolve(import.meta.dirname, './src'),
      '@test': resolve(import.meta.dirname, './test'),
    },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
