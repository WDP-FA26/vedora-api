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
      MUX_TOKEN_ID: 'e2e-token-id',
      MUX_TOKEN_SECRET: 'e2e-token-secret',
      MUX_WEBHOOK_SECRET: 'e2e-webhook-secret',
      RESEND_API_KEY: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      GOOGLE_CALLBACK_URL: '',
    },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
