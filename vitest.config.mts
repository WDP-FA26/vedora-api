import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// https://docs.nestjs.com/recipes/swc#vitest — SWC (unlike esbuild) emits the
// decorator metadata Nest's dependency injection reads.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    globals: true,
    root: './',
    // Specs that touch data use a database of their own (test/mongo-test-db.ts).
    hookTimeout: 60_000,
    maxWorkers: 4,
    coverage: { include: ['src/**/*.ts'], reportsDirectory: './coverage' },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
