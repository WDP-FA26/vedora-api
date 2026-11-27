import type { ConfigService } from '@nestjs/config';
import {
  defaultSettingsMiddleware,
  gateway as gatewayTools,
  type Tool,
  wrapEmbeddingModel,
  wrapLanguageModel,
} from 'ai';
import { runtimeConfig } from '../../../config/runtime-config.js';
import type {
  AiModelFactory,
  AiProviderAdapter,
  ChatModel,
  ChatModelOptions,
  EmbeddingModelV4,
  ProviderDialect,
  ProviderModelDefaults,
  ProviderModelKind,
} from '../ai-provider.interface.js';
import { ephemeralCache, providerOrderFrom } from '../provider-shared.js';
import { createGatewayClient } from './gateway.client.js';
import { gatewayCostAdapter } from './gateway.cost.js';
import {
  defaultReasoningMiddleware,
  gatewayEmbeddingMiddleware,
  searchSourcesMiddleware,
} from './gateway.middleware.js';

export const DEFAULT_GATEWAY_PROVIDER_ORDER = 'anthropic';

const AUTO_CACHING = { caching: 'auto' } as const;

export const GATEWAY_MODEL_DEFAULTS: ProviderModelDefaults = {
  image: 'microsoft/mai-image-2.7-flash',
  ocr: 'mistral/mistral-small',
  rerank: 'cohere/rerank-v5-fast',
};

const GATEWAY_MODEL_ENV: Record<ProviderModelKind, string> = {
  image: 'AI_GATEWAY_IMAGE_MODEL',
  ocr: 'AI_GATEWAY_OCR_MODEL',
  rerank: 'AI_GATEWAY_RERANK_MODEL',
};

export const gatewayDialect: ProviderDialect = {
  cacheBreakpoint: (ttl) => ({
    anthropic: { cacheControl: ephemeralCache(ttl) },
  }),
  callOptions: ({ sessionId, cacheTtl, effort }) => ({
    providerOptions: {
      gateway: { sessionId, ...(cacheTtl ? AUTO_CACHING : {}) },
    },
    ...(effort ? { reasoning: effort } : {}),
  }),
  pdfReading: () => ({}),
};

export function gatewayWebSearchTool(): Tool {
  return gatewayTools.tools.parallelSearch({
    mode: 'fast',
    maxResults: runtimeConfig.PLANNER_WEB_SEARCH_MAX_RESULTS,
  });
}

export function gatewayModels(apiKey: string): AiModelFactory {
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
          ? { providerOptions: { gateway: { order: [...providerOrder] } } }
          : {};
      return wrapLanguageModel({
        model: createGatewayClient(apiKey, customFetch).languageModel(modelId),
        middleware: [
          defaultSettingsMiddleware({ settings: routing }),
          defaultReasoningMiddleware(effort),
          searchSourcesMiddleware,
        ],
      });
    },
    embedding: (
      modelId,
      { dimensions, fetch: customFetch },
    ): EmbeddingModelV4 =>
      wrapEmbeddingModel({
        model: createGatewayClient(apiKey, customFetch).embeddingModel(modelId),
        middleware: gatewayEmbeddingMiddleware(dimensions),
      }),
    image: (modelId, { fetch: customFetch } = {}) =>
      createGatewayClient(apiKey, customFetch).imageModel(modelId),
    reranking: (modelId, { fetch: customFetch } = {}) =>
      createGatewayClient(apiKey, customFetch).rerankingModel(modelId),
    transcription: (modelId, { fetch: customFetch } = {}) =>
      createGatewayClient(apiKey, customFetch).transcriptionModel(modelId),
  };
}

export const gatewayAdapter: AiProviderAdapter = {
  id: 'gateway',
  serviceName: 'ai-gateway',
  dialect: gatewayDialect,
  cost: gatewayCostAdapter,
  modelDefaults: GATEWAY_MODEL_DEFAULTS,
  createModels: (config: ConfigService) =>
    gatewayModels(config.getOrThrow<string>('AI_GATEWAY_API_KEY')),
  modelIdFor: (config: ConfigService, kind: ProviderModelKind) =>
    config.get<string>(GATEWAY_MODEL_ENV[kind]) || GATEWAY_MODEL_DEFAULTS[kind],
  chatProviderOrder: (config: ConfigService) =>
    providerOrderFrom(
      config.get<string>(
        'AI_GATEWAY_PROVIDER_ORDER',
        DEFAULT_GATEWAY_PROVIDER_ORDER,
      ),
    ),
  moderationProviderOrder: (config: ConfigService) =>
    gatewayAdapter.chatProviderOrder(config),
  webSearchTool: gatewayWebSearchTool,
};
