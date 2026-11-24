import { runtimeConfig } from '../config/runtime-config.js';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  type EmbeddingModel,
  type ImageModel,
  type LanguageModel,
  wrapEmbeddingModel,
} from 'ai';
import type { ReasoningEffort } from './reasoning.js';

export {
  OpenRouterCacheControl,
  type AutoCachedProviderOptions,
  type CacheTtl,
  type EphemeralCacheSpec,
  type StickyProviderOptions,
} from './openrouter-cache.js';

export const DEFAULT_CHAT_MODEL = 'openrouter/auto';
export const DEFAULT_MODERATION_MODEL = 'anthropic/claude-haiku-5.5';
export const DEFAULT_CONTENT_MODERATION_MODEL = 'anthropic/claude-haiku-5.5';
export const DEFAULT_EMBEDDING_MODEL = 'google/gemini-embedding-2';
export const DEFAULT_IMAGE_MODEL = 'qwen/qwen-image-2.1-turbo';

const EMBEDDING_BATCH_SIZE = runtimeConfig.AI_EMBEDDING_BATCH_SIZE;

/**
 * Providers tried first for the Haiku moderation calls, by OpenRouter slug.
 * One provider first keeps the prompt cache on one provider; the others are
 * fallbacks when it is down.
 */
export const DEFAULT_MODERATION_PROVIDER_ORDER =
  'claude-on-aws,anthropic,amazon-bedrock,google-vertex,azure';

/** Provider slugs from a comma-separated list; empty leaves routing to OpenRouter. */
export function providerOrderFrom(value: string): string[] {
  const order: string[] = [];
  for (const slug of value.split(',')) {
    const trimmed = slug.trim();
    if (trimmed) order.push(trimmed);
  }
  return order;
}

export function chatModel({
  apiKey,
  modelId,
  reasoningEffort = 'low',
  providerOrder = [],
  fetch: customFetch,
}: {
  apiKey: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  /** OpenRouter provider slugs to try in this order, falling back to the rest. */
  providerOrder?: readonly string[];
  fetch?: typeof fetch;
}): Exclude<LanguageModel, string> {
  const routing =
    providerOrder.length > 0
      ? { provider: { order: [...providerOrder], allow_fallbacks: true } }
      : {};
  return createOpenRouter({
    apiKey,
    fetch: customFetch,
    baseURL: runtimeConfig.OPENROUTER_API_BASE_URL,
  })(modelId, {
    reasoning: { effort: reasoningEffort, exclude: true },
    ...routing,
  });
}

export function embeddingModel({
  apiKey,
  modelId,
  dimensions,
  fetch: customFetch,
}: {
  apiKey: string;
  modelId: string;
  dimensions: number;
  fetch?: typeof fetch;
}): EmbeddingModel {
  return wrapEmbeddingModel({
    model: createOpenRouter({
      apiKey,
      fetch: customFetch,
      baseURL: runtimeConfig.OPENROUTER_API_BASE_URL,
    }).textEmbeddingModel(modelId, {
      extraBody: { dimensions, encoding_format: 'float' },
    }),
    middleware: {
      overrideMaxEmbeddingsPerCall: () => EMBEDDING_BATCH_SIZE,
    },
  });
}

export function imageModel({
  apiKey,
  modelId,
  fetch: customFetch,
}: {
  apiKey: string;
  modelId: string;
  fetch?: typeof fetch;
}): ImageModel {
  return createOpenRouter({
    apiKey,
    fetch: customFetch,
    baseURL: runtimeConfig.OPENROUTER_API_BASE_URL,
  }).imageModel(modelId);
}
