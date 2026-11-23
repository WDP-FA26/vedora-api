import { defineConfig } from 'vitest/config';
import base from './vitest.config.e2e.mts';

// Separate process/config: runtime-config is frozen when imported, just as it is at production startup.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['test/provider/openai-adapter.spec.ts'],
    maxWorkers: 1,
    env: {
      ...base.test?.env,
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'fixture-openai-only',
      OPENROUTER_API_KEY: '',
      OPENAI_API_BASE_URL: 'http://127.0.0.1:4091/v1',
      OPENROUTER_API_BASE_URL: 'http://127.0.0.1:9/api/v1',
      POST_SUMMARIES_ENABLED: 'false',
      CAPTIONS_ENABLED: 'false',
    },
  },
});
