import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// https://docs.nestjs.com/recipes/swc#vitest — SWC (unlike esbuild) emits the
// decorator metadata Nest's dependency injection reads.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.spec.ts'],
    globals: true,
    root: './',
    // Specs that touch data use a database of their own (test/mongo-test-db.ts).
    globalSetup: ['test/support/global-setup.ts'],
    hookTimeout: 60_000,
    // Specs share one local MongoDB across workers; 5s is too tight under load.
    testTimeout: 15_000,
    // runtime-config imports dotenv/config; point it at an empty file so a
    // developer's .env (Cloudinary, OpenRouter, ...) cannot change results.
    // Feature specs assert OpenRouter's spelling of provider options; the
    // Gateway adapter has specs of its own (test/unit/ai/gateway.spec.ts).
    env: {
      DOTENV_CONFIG_PATH: 'test/unit/unit.env',
      AI_PROVIDER: 'openrouter',
    },
    maxWorkers: 4,
    coverage: {
      include: ['src/**/*.ts'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
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
