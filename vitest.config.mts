import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// https://docs.nestjs.com/recipes/swc#vitest — SWC (unlike esbuild) emits the
// decorator metadata Nest's dependency injection reads.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    globals: true,
    root: './',
    coverage: { include: ['src/**/*.ts'], reportsDirectory: './coverage' },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
