import { runtimeConfig } from '../config/runtime-config.js';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  type EmbeddingModel,
  type ImageModel,
  type LanguageModel,
  type SystemModelMessage,
  wrapEmbeddingModel,
} from 'ai';
import type { ReasoningEffort } from './reasoning.js';

export const DEFAULT_CHAT_MODEL = 'openrouter/auto';
export const DEFAULT_MODERATION_MODEL = 'anthropic/claude-haiku-5.5';
export const DEFAULT_CONTENT_MODERATION_MODEL = 'anthropic/claude-haiku-5.5';
export const DEFAULT_EMBEDDING_MODEL = 'google/gemini-embedding-2';
export const DEFAULT_IMAGE_MODEL = 'qwen/qwen-image-2.1-turbo';

const EMBEDDING_BATCH_SIZE = runtimeConfig.AI_EMBEDDING_BATCH_SIZE;

/**
 * A system prompt that ends in a cache breakpoint, for a prompt that stays the
 * same across calls (one policy version). Calls arrive minutes apart, so the
 * entry lives an hour (written at 2x the input price, read at 0.1x).
 */
export function cachedInstructions(content: string): SystemModelMessage {
  return {
    role: 'system',
    content,
    providerOptions: {
      openrouter: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
    },
  };
}

/**
 * Provider options that keep calls on one OpenRouter session, so they stay on
 * one provider (Anthropic, Bedrock or Vertex, each with its own cache). Without
 * a session id OpenRouter keys on the first user message, which differs for
 * every call, so cached prompts would scatter across providers.
 */
export function stickySession(sessionId: string): {
  openrouter: { session_id: string };
} {
  return { openrouter: { session_id: sessionId } };
}

export function chatModel({
  apiKey,
  modelId,
  reasoningEffort = 'low',
  fetch: customFetch,
}: {
  apiKey: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  fetch?: typeof fetch;
}): Exclude<LanguageModel, string> {
  return createOpenRouter({
    apiKey,
    fetch: customFetch,
    baseURL: runtimeConfig.OPENROUTER_API_BASE_URL,
  })(modelId, {
    reasoning: { effort: reasoningEffort, exclude: true },
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
