import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Opt-in MongoDB tests against TEST_DATABASE_URL. Each spec creates its own
// random database, builds the schema indexes, and drops it afterwards.
export default defineConfig({
  test: {
    include: ['test/db/**/*.db-spec.ts'],
    globals: true,
    globalSetup: ['test/support/global-setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 15_000,
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
