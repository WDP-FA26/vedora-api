import type { ConfigService } from '@nestjs/config';
import type {
  EmbeddingModel,
  ImageModel,
  LanguageModel,
  SystemModelMessage,
} from 'ai';
import { openRouterDialect, openRouterModels } from './openrouter.js';
import type { ReasoningEffort } from './reasoning.js';

/**
 * The seam between the app and the AI provider behind it. Features talk to AI
 * SDK models and to `PromptCache`; only this file and the provider adapters
 * (`openrouter.ts` today) know which provider serves them and how it spells
 * its per-call options.
 */

/** AI SDK provider options, keyed by provider name. */
export type ProviderOptions = NonNullable<
  SystemModelMessage['providerOptions']
>;

export type CacheTtl = '5m' | '1h';

/** A chat model as the AI SDK takes it, never a bare model id. */
export type ChatModel = Exclude<LanguageModel, string>;

/** How a provider spells prompt caching, session routing and reasoning effort. */
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
  }): ProviderOptions;
}

export interface ChatModelOptions {
  /** The model's default reasoning effort; a call can override it. */
  effort?: ReasoningEffort;
  /** Upstream providers to try first, in order, when the gateway routes between several. */
  providerOrder?: readonly string[];
  /** The cost transport's fetch, so each call is recorded. */
  fetch?: typeof fetch;
}

/** Builds the AI SDK models the app uses, from one provider. */
export interface AiModelFactory {
  chat(modelId: string, options?: ChatModelOptions): ChatModel;
  embedding(
    modelId: string,
    options: { dimensions: number; fetch?: typeof fetch },
  ): EmbeddingModel;
  image(modelId: string, options?: { fetch?: typeof fetch }): ImageModel;
}

/** The dialect of the provider in use. */
export const providerDialect: ProviderDialect = openRouterDialect;

/** The model factory of the provider in use, with its credentials from the config. */
export function aiModels(config: ConfigService): AiModelFactory {
  return openRouterModels(config.getOrThrow<string>('OPENROUTER_API_KEY'));
}
