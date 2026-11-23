import type { ConfigService } from '@nestjs/config';
import { createOpenAI } from '@ai-sdk/openai';
import { wrapEmbeddingModel, wrapLanguageModel } from 'ai';
import { evaluationModel } from '../common/decision/decision.js';
import { runtimeConfig } from '../config/runtime-config.js';
import type { AiCostTransportService } from './telemetry/ai-cost-transport.service.js';
import {
  chatModel,
  embeddingModel,
  imageModel,
  DEFAULT_CHAT_MODEL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_CONTENT_MODERATION_MODEL,
  DEFAULT_MODERATION_MODEL,
  DEFAULT_MODERATION_EVIDENCE_MODEL,
} from './openrouter.js';
import { openaiEvaluation } from './openai-evaluation.js';
import type { ReasoningEffort } from './reasoning.js';

export const isOpenAI = (config: ConfigService) =>
  config.get<string>('AI_PROVIDER', 'openrouter') === 'openai';
type Costs = Pick<AiCostTransportService, 'forModel' | 'forProvider'>;
type ChatSlot = 'default' | 'blog' | 'evidence';

export function activeChatModelId(
  config: ConfigService,
  slot: ChatSlot = 'default',
) {
  if (isOpenAI(config))
    return (
      config.get<string>(
        slot === 'blog'
          ? 'OPENAI_BLOG_MODEL'
          : slot === 'evidence'
            ? 'OPENAI_EVIDENCE_MODEL'
            : 'OPENAI_MODEL',
      ) || config.get<string>('OPENAI_MODEL', 'gpt-6-luna')
    );
  return slot === 'evidence'
    ? config.get<string>(
        'OPENROUTER_MODERATION_EVIDENCE_MODEL',
        DEFAULT_MODERATION_EVIDENCE_MODEL,
      )
    : (slot === 'blog' ? config.get<string>('BLOG_AI_MODEL') : undefined) ||
        config.get<string>('OPENROUTER_MODEL', DEFAULT_CHAT_MODEL);
}

export function activeChatModel(
  config: ConfigService,
  costs: Costs,
  slot: ChatSlot = 'default',
) {
  const id = activeChatModelId(config, slot);
  if (!isOpenAI(config))
    return chatModel({
      apiKey: config.getOrThrow<string>('OPENROUTER_API_KEY'),
      modelId: id,
      reasoningEffort: config.get<ReasoningEffort>(
        'OPENROUTER_REASONING_EFFORT',
        'low',
      ),
      fetch: costs.forModel(
        id,
        slot === 'evidence' ? 'CONTENT_MODERATION' : 'SYSTEM',
      ),
    });
  const model = createOpenAI({
    apiKey: config.getOrThrow<string>('OPENAI_API_KEY'),
    baseURL: runtimeConfig.OPENAI_API_BASE_URL,
    fetch: costs.forProvider(
      'openai',
      id,
      slot === 'evidence' ? 'CONTENT_MODERATION' : 'SYSTEM',
    ),
  }).responses(id);
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: ({ params }) =>
        Promise.resolve({
          ...params,
          providerOptions: {
            ...params.providerOptions,
            openai: {
              include: ['reasoning.encrypted_content'],
              ...params.providerOptions?.openai,
              store: false,
            },
          },
        }),
    },
  });
}

export function activeEvaluationModel(
  config: ConfigService,
  costs: Costs,
  content = false,
) {
  if (!isOpenAI(config)) {
    const id = config.get<string>(
      content
        ? 'OPENROUTER_CONTENT_MODERATION_MODEL'
        : 'OPENROUTER_MODERATION_MODEL',
      content ? DEFAULT_CONTENT_MODERATION_MODEL : DEFAULT_MODERATION_MODEL,
    );
    return evaluationModel({
      apiKey: config.getOrThrow<string>('OPENROUTER_API_KEY'),
      modelId: id,
      fetch: costs.forModel(id, 'CONTENT_MODERATION'),
    });
  }
  const id = config.get<string>('OPENAI_DECISION_MODEL', 'gpt-6-luna');
  return openaiEvaluation({
    apiKey: config.getOrThrow<string>('OPENAI_API_KEY'),
    modelId: id,
    baseURL: runtimeConfig.OPENAI_API_BASE_URL,
    fetch: costs.forProvider('openai', id, 'CONTENT_MODERATION'),
  });
}

export function activeEmbeddingModel(
  config: ConfigService,
  costs: Costs,
  posts = false,
) {
  const dimensions = config.get<number>(
    posts
      ? 'POST_SEARCH_EMBEDDING_DIMENSIONS'
      : 'KNOWLEDGE_EMBEDDING_DIMENSIONS',
    posts ? 768 : 1536,
  );
  const id = isOpenAI(config)
    ? config.get<string>('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small')
    : config.get<string>(
        posts ? 'POST_SEARCH_EMBEDDING_MODEL' : 'OPENROUTER_EMBEDDING_MODEL',
        DEFAULT_EMBEDDING_MODEL,
      );
  const feature = posts ? 'POSTS' : 'KNOWLEDGE';
  if (!isOpenAI(config))
    return embeddingModel({
      apiKey: config.getOrThrow<string>('OPENROUTER_API_KEY'),
      modelId: id,
      dimensions,
      fetch: costs.forModel(id, feature),
    });
  return wrapEmbeddingModel({
    model: createOpenAI({
      apiKey: config.getOrThrow<string>('OPENAI_API_KEY'),
      baseURL: runtimeConfig.OPENAI_API_BASE_URL,
      fetch: costs.forProvider('openai', id, feature),
    }).embeddingModel(id),
    middleware: {
      overrideMaxEmbeddingsPerCall: () => runtimeConfig.AI_EMBEDDING_BATCH_SIZE,
      transformParams: ({ params }) =>
        Promise.resolve({
          ...params,
          providerOptions: {
            ...params.providerOptions,
            openai: { ...params.providerOptions?.openai, dimensions },
          },
        }),
    },
  });
}

export function activeImageModel(config: ConfigService, costs: Costs) {
  const id = config.get<string>(
    isOpenAI(config) ? 'OPENAI_IMAGE_MODEL' : 'OPENROUTER_IMAGE_MODEL',
    isOpenAI(config) ? 'gpt-image-1' : DEFAULT_IMAGE_MODEL,
  );
  return isOpenAI(config)
    ? createOpenAI({
        apiKey: config.getOrThrow<string>('OPENAI_API_KEY'),
        baseURL: runtimeConfig.OPENAI_API_BASE_URL,
        fetch: costs.forProvider('openai', id),
      }).image(id)
    : imageModel({
        apiKey: config.getOrThrow<string>('OPENROUTER_API_KEY'),
        modelId: id,
        fetch: costs.forModel(id),
      });
}
