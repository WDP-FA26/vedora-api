import { runtimeConfig } from '../config/runtime-config.js';
import {
  createOpenRouter,
  type OpenRouterProvider,
} from '@openrouter/ai-sdk-provider';
import {
  type EmbeddingModel,
  type ImageModel,
  type LanguageModel,
  wrapEmbeddingModel,
} from 'ai';
import type { ReasoningEffort } from './reasoning.js';
import { openRouterAttribution } from './openrouter-attribution.js';

export {
  DEFAULT_OPENROUTER_APP_TITLE,
  DEFAULT_OPENROUTER_APP_URL,
  openRouterAttribution,
  openRouterAttributionHeaders,
  type OpenRouterAttribution,
  type OpenRouterAttributionHeaders,
} from './openrouter-attribution.js';
export {
  OpenRouterCacheControl,
  type AutoCachedProviderOptions,
  type CacheTtl,
  type EphemeralCacheSpec,
  type StickyProviderOptions,
} from './openrouter-cache.js';

export const DEFAULT_CHAT_MODEL = 'anthropic/claude-haiku-5.5';
export const DEFAULT_MODERATION_MODEL = 'anthropic/claude-haiku-5.5';
export const DEFAULT_CONTENT_MODERATION_MODEL = 'anthropic/claude-haiku-5.5';
export const DEFAULT_EMBEDDING_MODEL = 'google/gemini-embedding-2';
export const DEFAULT_IMAGE_MODEL = 'qwen/qwen-image-2.1-turbo';

const EMBEDDING_BATCH_SIZE = runtimeConfig.AI_EMBEDDING_BATCH_SIZE;

/**
 * Providers tried first for the Haiku moderation calls, by OpenRouter slug.
 * Both moderation callers require `structured_outputs` (`Output.object`), so
 * only endpoints supporting `structured_outputs` on `anthropic/claude-haiku-5.5`
 * are listed (`claude-on-aws` and `amazon-bedrock` do not support it and are
 * filtered out by OpenRouter before `order` applies).
 */
export const DEFAULT_MODERATION_PROVIDER_ORDER =
  'anthropic,google-vertex/global,azure/global';

interface ProviderOptions {
  apiKey: string;
  modelId: string;
  /** The cost transport's fetch, so each call is recorded. */
  fetch?: typeof fetch;
}

/** Provider slugs from a comma-separated list; empty leaves routing to OpenRouter. */
export function providerOrderFrom(value: string): string[] {
  const order: string[] = [];
  for (const slug of value.split(',')) {
    const trimmed = slug.trim();
    if (trimmed) order.push(trimmed);
  }
  return order;
}

/** The OpenRouter provider with Vedora's base URL and app attribution. */
function openRouter(
  apiKey: string,
  customFetch?: typeof fetch,
): OpenRouterProvider {
  const { appUrl, appTitle } = openRouterAttribution();
  return createOpenRouter({
    apiKey,
    fetch: customFetch,
    baseURL: runtimeConfig.OPENROUTER_API_BASE_URL,
    appName: appTitle,
    appUrl,
  });
}

export function chatModel({
  apiKey,
  modelId,
  reasoningEffort = 'low',
  providerOrder = [],
  fetch: customFetch,
}: ProviderOptions & {
  reasoningEffort?: ReasoningEffort;
  /** OpenRouter provider slugs to try in this order, falling back to the rest. */
  providerOrder?: readonly string[];
}): Exclude<LanguageModel, string> {
  const routing =
    providerOrder.length > 0
      ? { provider: { order: [...providerOrder], allow_fallbacks: true } }
      : {};
  return openRouter(apiKey, customFetch)(modelId, {
    reasoning: { effort: reasoningEffort, exclude: true },
    ...routing,
  });
}

export function embeddingModel({
  apiKey,
  modelId,
  dimensions,
  fetch: customFetch,
}: ProviderOptions & { dimensions: number }): EmbeddingModel {
  // The provider has no `dimensions` setting, so it goes in the request body.
  const model = openRouter(apiKey, customFetch).textEmbeddingModel(modelId, {
    extraBody: { dimensions, encoding_format: 'float' },
  });
  return wrapEmbeddingModel({
    model,
    middleware: { overrideMaxEmbeddingsPerCall: () => EMBEDDING_BATCH_SIZE },
  });
}

export function imageModel({
  apiKey,
  modelId,
  fetch: customFetch,
}: ProviderOptions): ImageModel {
  return openRouter(apiKey, customFetch).imageModel(modelId);
}
