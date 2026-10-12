import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Opt-in PostgreSQL tests. Each run migrates and drops its own random schema.
export default defineConfig({
  test: {
    include: ['test/**/*.db-spec.ts'],
    globals: true,
    hookTimeout: 60_000,
    testTimeout: 15_000,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
