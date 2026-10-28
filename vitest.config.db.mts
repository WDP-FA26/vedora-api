import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Opt-in MongoDB tests against TEST_DATABASE_URL. Each spec creates its own
// random database, builds the schema indexes, and drops it afterwards.
export default defineConfig({
  test: {
    include: ['test/**/*.db-spec.ts'],
    globals: true,
    hookTimeout: 60_000,
    testTimeout: 15_000,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
