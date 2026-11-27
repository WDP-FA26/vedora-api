import type { ConfigService } from '@nestjs/config';
import {
  createOpenRouter,
  type OpenRouterProvider,
} from '@openrouter/ai-sdk-provider';
import { type Tool, wrapEmbeddingModel } from 'ai';
import { z } from 'zod';
import { runtimeConfig } from '../../../config/runtime-config.js';
import type { ReasoningEffort } from '../../reasoning.js';
import type {
  AiModelFactory,
  AiProviderAdapter,
  ChatModel,
  ChatModelOptions,
  ProviderDialect,
  ProviderModelDefaults,
  ProviderModelKind,
} from '../ai-provider.interface.js';
import {
  aiAppAttribution,
  ephemeralCache,
  providerOrderFrom,
} from '../provider-shared.js';
import { createOpenRouterClient } from './openrouter.client.js';
import { openRouterCostAdapter } from './openrouter.cost.js';
import {
  multimodalEmbeddingMiddleware,
  openRouterRerankingModel,
  openRouterTranscriptionModel,
} from './openrouter.sdk-models.js';

export const OPENROUTER_MODEL_DEFAULTS: ProviderModelDefaults = {
  image: 'qwen/qwen-image-2.1-turbo',
  ocr: 'mistralai/mistral-small-2603',
  rerank: 'qwen/qwen3-reranker-8b',
};

const OPENROUTER_MODEL_ENV: Record<ProviderModelKind, string> = {
  image: 'OPENROUTER_IMAGE_MODEL',
  ocr: 'OPENROUTER_OCR_MODEL',
  rerank: 'OPENROUTER_RERANK_MODEL',
};

const EMBEDDING_BATCH_SIZE = runtimeConfig.AI_EMBEDDING_BATCH_SIZE;

export const DEFAULT_OPENROUTER_MODERATION_PROVIDER_ORDER =
  'anthropic,google-vertex/global,azure/global';

export const DEFAULT_OPENROUTER_CHAT_PROVIDER_ORDER =
  DEFAULT_OPENROUTER_MODERATION_PROVIDER_ORDER;

type ReasoningSetting = {
  effort: ReasoningEffort;
  exclude: true;
};

function reasoningSetting(effort: ReasoningEffort): ReasoningSetting {
  return { effort, exclude: true };
}

function openRouter(
  apiKey: string,
  customFetch?: typeof fetch,
): OpenRouterProvider {
  const { appUrl, appTitle } = aiAppAttribution();
  return createOpenRouter({
    apiKey,
    fetch: customFetch,
    baseURL: runtimeConfig.OPENROUTER_API_BASE_URL,
    appName: appTitle,
    appUrl,
  });
}

export const openRouterDialect: ProviderDialect = {
  cacheBreakpoint: (ttl) => ({
    openrouter: { cacheControl: ephemeralCache(ttl) },
  }),
  callOptions: ({ sessionId, cacheTtl, effort }) => ({
    providerOptions: {
      openrouter: {
        session_id: sessionId,
        ...(cacheTtl ? { cacheControl: ephemeralCache(cacheTtl) } : {}),
        ...(effort ? { reasoning: reasoningSetting(effort) } : {}),
      },
    },
  }),
  pdfReading: () => ({
    openrouter: {
      plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
    },
  }),
};

export function openRouterWebSearchTool(): Tool {
  return {
    type: 'provider',
    id: 'openrouter.web_search',
    isProviderExecuted: true,
    args: {
      parameters: {
        engine: runtimeConfig.PLANNER_WEB_SEARCH_ENGINE,
        mode: runtimeConfig.PLANNER_WEB_SEARCH_MODE,
        search_context_size: runtimeConfig.PLANNER_WEB_SEARCH_CONTEXT_SIZE,
        max_results: runtimeConfig.PLANNER_WEB_SEARCH_MAX_RESULTS,
        max_total_results: runtimeConfig.PLANNER_WEB_SEARCH_MAX_TOTAL_RESULTS,
        max_uses: runtimeConfig.PLANNER_WEB_SEARCH_MAX_USES,
      },
    },
    inputSchema: z.object({}),
  };
}

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
      const model = openRouter(apiKey, customFetch).textEmbeddingModel(
        modelId,
        {
          extraBody: { dimensions, encoding_format: 'float' },
        },
      );
      return wrapEmbeddingModel({
        model,
        middleware: [
          {
            specificationVersion: 'v4',
            overrideMaxEmbeddingsPerCall: () => EMBEDDING_BATCH_SIZE,
          },
          multimodalEmbeddingMiddleware(
            apiKey,
            modelId,
            dimensions,
            customFetch,
          ),
        ],
      });
    },
    image: (modelId, { fetch: customFetch } = {}) =>
      openRouter(apiKey, customFetch).imageModel(modelId),
    reranking: (modelId, { fetch: customFetch } = {}) =>
      openRouterRerankingModel(
        createOpenRouterClient(apiKey, customFetch),
        modelId,
      ),
    transcription: (modelId, { fetch: customFetch } = {}) =>
      openRouterTranscriptionModel(
        createOpenRouterClient(apiKey, customFetch),
        modelId,
      ),
  };
}

export const openRouterAdapter: AiProviderAdapter = {
  id: 'openrouter',
  serviceName: 'openrouter',
  dialect: openRouterDialect,
  cost: openRouterCostAdapter,
  modelDefaults: OPENROUTER_MODEL_DEFAULTS,
  createModels: (config: ConfigService) =>
    openRouterModels(config.getOrThrow<string>('OPENROUTER_API_KEY')),
  modelIdFor: (config: ConfigService, kind: ProviderModelKind) =>
    config.get<string>(OPENROUTER_MODEL_ENV[kind]) ||
    OPENROUTER_MODEL_DEFAULTS[kind],
  chatProviderOrder: (config: ConfigService) =>
    providerOrderFrom(
      config.get<string>(
        'OPENROUTER_PROVIDER_ORDER',
        DEFAULT_OPENROUTER_CHAT_PROVIDER_ORDER,
      ),
    ),
  moderationProviderOrder: (config: ConfigService) =>
    providerOrderFrom(
      config.get<string>(
        'OPENROUTER_MODERATION_PROVIDER_ORDER',
        DEFAULT_OPENROUTER_MODERATION_PROVIDER_ORDER,
      ),
    ),
  webSearchTool: openRouterWebSearchTool,
};
