import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  type EmbeddingModel,
  type ImageModel,
  type LanguageModel,
  wrapEmbeddingModel,
} from 'ai';
import type { ReasoningEffort } from './reasoning.js';

export const DEFAULT_CHAT_MODEL = 'openrouter/auto';
export const DEFAULT_MODERATION_MODEL = 'typesafe/jev-1.14';
export const DEFAULT_CONTENT_MODERATION_MODEL = 'openai/gpt-6-luna-decisions';
export const DEFAULT_EMBEDDING_MODEL = 'google/gemini-embedding-2';
export const DEFAULT_IMAGE_MODEL = 'qwen/qwen-image-2.1-turbo';

const EMBEDDING_BATCH_SIZE = 64;

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
}): LanguageModel {
  return createOpenRouter({ apiKey, fetch: customFetch })(modelId, {
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
    model: createOpenRouter({ apiKey, fetch: customFetch }).textEmbeddingModel(
      modelId,
      {
        extraBody: { dimensions, encoding_format: 'float' },
      },
    ),
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
  return createOpenRouter({ apiKey, fetch: customFetch }).imageModel(modelId);
}
