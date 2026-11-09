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
export const DEFAULT_CONTENT_MODERATION_MODEL = 'perplexity/pplx-decider-v1.2';
export const DEFAULT_EMBEDDING_MODEL = 'google/gemini-embedding-2';
export const DEFAULT_IMAGE_MODEL = 'qwen/qwen-image-2.1-turbo';

const EMBEDDING_BATCH_SIZE = 64;

export function chatModel({
  apiKey,
  modelId,
  reasoningEffort = 'low',
}: {
  apiKey: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}): LanguageModel {
  return createOpenRouter({ apiKey })(modelId, {
    reasoning: { effort: reasoningEffort, exclude: true },
  });
}

export function embeddingModel({
  apiKey,
  modelId,
  dimensions,
}: {
  apiKey: string;
  modelId: string;
  dimensions: number;
}): EmbeddingModel {
  return wrapEmbeddingModel({
    model: createOpenRouter({ apiKey }).textEmbeddingModel(modelId, {
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
}: {
  apiKey: string;
  modelId: string;
}): ImageModel {
  return createOpenRouter({ apiKey }).imageModel(modelId);
}
