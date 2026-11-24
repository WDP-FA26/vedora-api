import { runtimeConfig } from '../config/runtime-config.js';
import {
  createOpenRouter,
  type OpenRouterProvider,
} from '@openrouter/ai-sdk-provider';
import { wrapEmbeddingModel } from 'ai';
import type {
  AiModelFactory,
  CacheTtl,
  ChatModel,
  ChatModelOptions,
  ProviderDialect,
} from './provider.js';
import { reasoningSetting } from './reasoning.js';
import { openRouterAttribution } from './openrouter-attribution.js';

export {
  DEFAULT_OPENROUTER_APP_TITLE,
  DEFAULT_OPENROUTER_APP_URL,
  openRouterAttribution,
  openRouterAttributionHeaders,
  type OpenRouterAttribution,
  type OpenRouterAttributionHeaders,
} from './openrouter-attribution.js';

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

/**
 * The same providers for the chat models (Haiku by default): the structured
 * outputs they rely on need them, and a prompt cache lives on one provider.
 */
export const DEFAULT_CHAT_PROVIDER_ORDER = DEFAULT_MODERATION_PROVIDER_ORDER;

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

/** Anthropic's cache breakpoint as OpenRouter passes it on; 5 minutes is the default. */
export type EphemeralCacheSpec = {
  type: 'ephemeral';
  ttl?: '1h';
};

export function ephemeralCache(ttl: CacheTtl = '1h'): EphemeralCacheSpec {
  if (ttl === '1h') return { type: 'ephemeral', ttl: '1h' };
  return { type: 'ephemeral' };
}

/**
 * OpenRouter's spelling: `cacheControl` for Anthropic breakpoints (also as the
 * request-level advancing breakpoint), `session_id` for sticky routing, and
 * `reasoning` for the effort.
 */
export const openRouterDialect: ProviderDialect = {
  cacheBreakpoint: (ttl) => ({
    openrouter: { cacheControl: ephemeralCache(ttl) },
  }),
  callOptions: ({ sessionId, cacheTtl, effort }) => ({
    openrouter: {
      session_id: sessionId,
      ...(cacheTtl ? { cacheControl: ephemeralCache(cacheTtl) } : {}),
      ...(effort ? { reasoning: reasoningSetting(effort) } : {}),
    },
  }),
};

/** The app's models served by OpenRouter. */
export function openRouterModels(apiKey: string): AiModelFactory {
  return {
    chat: (
      modelId: string,
      {
        effort = 'low',
        providerOrder = [],
        fetch: customFetch,
      }: ChatModelOptions = {},
    ): ChatModel => {
      const routing =
        providerOrder.length > 0
          ? { provider: { order: [...providerOrder], allow_fallbacks: true } }
          : {};
      return openRouter(apiKey, customFetch)(modelId, {
        reasoning: reasoningSetting(effort),
        ...routing,
      });
    },
    embedding: (modelId, { dimensions, fetch: customFetch }) => {
      // The provider has no `dimensions` setting, so it goes in the request body.
      const model = openRouter(apiKey, customFetch).textEmbeddingModel(
        modelId,
        {
          extraBody: { dimensions, encoding_format: 'float' },
        },
      );
      return wrapEmbeddingModel({
        model,
        middleware: {
          overrideMaxEmbeddingsPerCall: () => EMBEDDING_BATCH_SIZE,
        },
      });
    },
    image: (modelId, { fetch: customFetch } = {}) =>
      openRouter(apiKey, customFetch).imageModel(modelId),
  };
}
