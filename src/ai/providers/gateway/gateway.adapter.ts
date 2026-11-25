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

/**
 * Gateway provider slugs tried first for the chat models. The prompt cache
 * lives on one provider, so Anthropic's own API goes first; the Gateway still
 * moves to its other Haiku hosts (Vertex, Bedrock) when Anthropic fails.
 */
export const DEFAULT_GATEWAY_PROVIDER_ORDER = 'anthropic';

const AUTO_CACHING = { caching: 'auto' } as const;

/** Gateway models whose OpenRouter ids differ. */
export const GATEWAY_MODEL_DEFAULTS: ProviderModelDefaults = {
  // Takes the editor's aspect ratios as they are; about $0.01 an image.
  image: 'microsoft/mai-image-2.7-flash',
  // Reads scanned pages through Mistral's own PDF handling, about $0.00003 a page.
  ocr: 'mistral/mistral-small',
  // Multilingual and built for low latency (the rerank budget is 1.6 s).
  rerank: 'cohere/rerank-v5-fast',
};

const GATEWAY_MODEL_ENV: Record<ProviderModelKind, string> = {
  image: 'AI_GATEWAY_IMAGE_MODEL',
  ocr: 'AI_GATEWAY_OCR_MODEL',
  rerank: 'AI_GATEWAY_RERANK_MODEL',
};

/**
 * The Gateway's spelling (vercel.com/docs/ai-gateway, automatic caching and
 * session affinity):
 * - breakpoints: Anthropic's `cacheControl`, passed on to Anthropic, Vertex
 *   and Bedrock; a 1h breakpoint also keeps the session pin for an hour.
 * - `gateway.sessionId`: pins a session's calls to one provider so its cache
 *   stays warm. Without it the Gateway fingerprints the conversation and pins
 *   only prompts above the provider's minimum cache size.
 * - `gateway.caching: 'auto'`: the advancing breakpoint, markers on the last
 *   message and the one before the last user message, always 5 minutes (the
 *   only history TTL in use). With the system breakpoint that makes at most
 *   three of Anthropic's four. It also turns a 1h system breakpoint into a
 *   5m one (measured 2026-11-25), so agents keep `systemTtl: '5m'`; the 1h
 *   single-turn calls never set `cacheTtl` and keep their hour.
 * - the AI SDK's own `reasoning` option for the effort.
 */
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
  // Mistral reads PDF pages, scanned or not, with its own OCR.
  pdfReading: () => ({}),
};

/**
 * The Gateway's Parallel search in `fast` mode (free on the Gateway), the
 * engine and mode OpenRouter's web search is configured with.
 */
export function gatewayWebSearchTool(): Tool {
  return gatewayTools.tools.parallelSearch({
    mode: 'fast',
    maxResults: runtimeConfig.PLANNER_WEB_SEARCH_MAX_RESULTS,
  });
}

/** The app's models served by Vercel AI Gateway. */
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
