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

export type ProviderOptions = NonNullable<
  SystemModelMessage['providerOptions']
>;

export type CacheTtl = '5m' | '1h';

export type ChatModel = ReturnType<typeof wrapLanguageModel>;

export type EmbeddingModelV4 = ReturnType<typeof wrapEmbeddingModel>;

export const AI_PROVIDERS = ['gateway', 'openrouter'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];
export type AiProvider = AiProviderId;

export type AiServiceName = 'ai-gateway' | 'openrouter';

export interface CallOptions {
  providerOptions: ProviderOptions;
  reasoning?: ReasoningEffort;
}

export interface ChatModelOptions {
  effort?: ReasoningEffort;
  providerOrder?: readonly string[];
  fetch?: typeof fetch;
}

export interface ProviderDialect {
  cacheBreakpoint(ttl: CacheTtl): ProviderOptions;
  callOptions(call: {
    sessionId: string;
    cacheTtl?: CacheTtl;
    effort?: ReasoningEffort;
  }): CallOptions;
  pdfReading(): ProviderOptions;
}

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

export interface ProviderModelDefaults {
  image: string;
  ocr: string;
  rerank: string;
}

export type ProviderModelKind = keyof ProviderModelDefaults;

export interface GenerationFallback {
  resolvedModel: string | null;
  provider: string | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
}

export interface ProviderCostAdapter {
  readonly baseUrl: string;
  parsePayload(payload: unknown, observation: CostObservation): void;
  lookupGeneration(
    config: ConfigService,
    generationId: string,
    fallback: GenerationFallback,
  ): Promise<CostObservation>;
}

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
