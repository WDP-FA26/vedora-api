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
    hookTimeout: 60_000,
    // Specs share one local MongoDB across workers; 5s is too tight under load.
    testTimeout: 15_000,
    // runtime-config imports dotenv/config; point it at an empty file so a
    // developer's .env (Cloudinary, OpenRouter, ...) cannot change results.
    env: { DOTENV_CONFIG_PATH: 'test/unit/unit.env' },
    maxWorkers: 4,
    coverage: {
      include: ['src/**/*.ts'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
    },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
