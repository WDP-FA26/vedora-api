import type {
  ImageModelV4,
  RerankingModelV4,
  TranscriptionModelV4,
} from '@ai-sdk/provider';
import type { ConfigService } from '@nestjs/config';
import type {
  SystemModelMessage,
  Tool,
  wrapEmbeddingModel,
  wrapLanguageModel,
} from 'ai';
import type { ReasoningEffort } from '../reasoning.js';
import type { CostObservation } from '../telemetry/cost-observation.js';

/**
 * Segregated contracts between the app and AI provider adapters.
 * Features talk to AI SDK v4 models (`@ai-sdk/provider`), `PromptCache`, and
 * `webSearchTool()`; only `providers/` adapters know provider-specific
 * options, clients, endpoints, and billing formats.
 */

/** AI SDK provider options, keyed by provider name. */
export type ProviderOptions = NonNullable<
  SystemModelMessage['providerOptions']
>;

export type CacheTtl = '5m' | '1h';

/** A chat model as the AI SDK takes it, never a bare model id. */
export type ChatModel = ReturnType<typeof wrapLanguageModel>;

export type EmbeddingModelV4 = ReturnType<typeof wrapEmbeddingModel>;

export const AI_PROVIDERS = ['gateway', 'openrouter'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];
export type AiProvider = AiProviderId;

export type AiServiceName = 'ai-gateway' | 'openrouter';

/** What a dialect adds to a `generateText`/`streamText`/agent call. */
export interface CallOptions {
  providerOptions: ProviderOptions;
  /** The AI SDK's own effort option, for providers that read it. */
  reasoning?: ReasoningEffort;
}

export interface ChatModelOptions {
  /** The model's default reasoning effort; a call can override it. */
  effort?: ReasoningEffort;
  /** Upstream providers to try first, in order, in the spelling of the provider in use. */
  providerOrder?: readonly string[];
  /** The cost transport's fetch, so each call is recorded. */
  fetch?: typeof fetch;
}

/** How a provider spells prompt caching, session routing, and PDF OCR options. */
export interface ProviderDialect {
  /** Options that make a system message or a content part a cache breakpoint. */
  cacheBreakpoint(ttl: CacheTtl): ProviderOptions;
  /**
   * Options for one call: keep a session's calls on one route (so its cache
   * stays warm), optionally advance a cache breakpoint with the conversation,
   * and optionally override the model's reasoning effort.
   */
  callOptions(call: {
    sessionId: string;
    cacheTtl?: CacheTtl;
    effort?: ReasoningEffort;
  }): CallOptions;
  /**
   * Options for a call that reads a PDF page, so a scanned page is read too:
   * OpenRouter otherwise parses PDFs from their text layer only.
   */
  pdfReading(): ProviderOptions;
}

/** Builds the AI SDK models the app uses, from one provider. */
export interface AiModelFactory {
  chat(modelId: string, options?: ChatModelOptions): ChatModel;
  embedding(
    modelId: string,
    options: { dimensions: number; fetch?: typeof fetch },
  ): EmbeddingModelV4;
  image(modelId: string, options?: { fetch?: typeof fetch }): ImageModelV4;
  reranking(
    modelId: string,
    options?: { fetch?: typeof fetch },
  ): RerankingModelV4;
  transcription(
    modelId: string,
    options?: { fetch?: typeof fetch },
  ): TranscriptionModelV4;
}

/** Models whose ids differ between the providers. */
export interface ProviderModelDefaults {
  /** Blog image generation. */
  image: string;
  /** Knowledge base PDF OCR, a chat model that reads PDFs. */
  ocr: string;
  /** Knowledge base search reranking. */
  rerank: string;
}

export type ProviderModelKind = keyof ProviderModelDefaults;

export interface GenerationFallback {
  resolvedModel: string | null;
  provider: string | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
}

/** Provider-specific billing payload parsing and generation reconciliation. */
export interface ProviderCostAdapter {
  readonly baseUrl: string;
  parsePayload(payload: unknown, observation: CostObservation): void;
  lookupGeneration(
    config: ConfigService,
    generationId: string,
    fallback: GenerationFallback,
  ): Promise<CostObservation>;
}

/** Complete adapter plugin for a single AI provider. */
export interface AiProviderAdapter {
  readonly id: AiProviderId;
  readonly serviceName: AiServiceName;
  readonly dialect: ProviderDialect;
  readonly cost: ProviderCostAdapter;
  readonly modelDefaults: ProviderModelDefaults;

  createModels(config: ConfigService): AiModelFactory;
  modelIdFor(config: ConfigService, kind: ProviderModelKind): string;
  chatProviderOrder(config: ConfigService): string[];
  moderationProviderOrder(config: ConfigService): string[];
  webSearchTool(): Tool;
}
