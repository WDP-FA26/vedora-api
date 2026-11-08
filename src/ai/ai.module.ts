import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiModule as NestAiModule } from '@nestjs/ai';
import {
  chatModel,
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_MODERATION_MODEL,
  embeddingModel,
} from './openrouter.js';
import type { ReasoningEffort } from './reasoning.js';

@Module({
  imports: [
    NestAiModule.forRootAsync({
      isGlobal: true,
      modelNames: ['default', 'blog', 'moderation'],
      embeddingModelNames: ['default', 'posts'],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const apiKey = config.getOrThrow<string>('OPENROUTER_API_KEY');
        const defaultModelId = config.get<string>(
          'OPENROUTER_MODEL',
          DEFAULT_CHAT_MODEL,
        );
        const reasoningEffort = config.get<ReasoningEffort>(
          'OPENROUTER_REASONING_EFFORT',
          'low',
        );
        return {
          models: {
            default: chatModel({
              apiKey,
              modelId: defaultModelId,
              reasoningEffort,
            }),
            // `openrouter/auto` may route to a model that calls tools poorly;
            // pin one for the blog agent with BLOG_AI_MODEL
            blog: chatModel({
              apiKey,
              modelId: config.get<string>('BLOG_AI_MODEL') || defaultModelId,
              reasoningEffort,
            }),
            moderation: {
              model: chatModel({
                apiKey,
                modelId: config.get<string>(
                  'OPENROUTER_MODERATION_MODEL',
                  DEFAULT_MODERATION_MODEL,
                ),
                reasoningEffort: 'low',
              }),
              timeout: '4s',
              retry: {
                attempts: 3,
                backoff: { delay: '400ms', maxDelay: '2s', jitter: 'none' },
              },
            },
          },
          embeddingModels: {
            default: embeddingModel({
              apiKey,
              modelId: config.get<string>(
                'OPENROUTER_EMBEDDING_MODEL',
                DEFAULT_EMBEDDING_MODEL,
              ),
              dimensions: config.get<number>(
                'KNOWLEDGE_EMBEDDING_DIMENSIONS',
                1536,
              ),
            }),
            posts: {
              model: embeddingModel({
                apiKey,
                modelId: config.get<string>(
                  'POST_SEARCH_EMBEDDING_MODEL',
                  DEFAULT_EMBEDDING_MODEL,
                ),
                dimensions: config.get<number>(
                  'POST_SEARCH_EMBEDDING_DIMENSIONS',
                  768,
                ),
              }),
              timeout: '30s',
            },
          },
        };
      },
    }),
  ],
})
export class AiModule {}
