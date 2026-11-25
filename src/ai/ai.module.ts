import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiModule as NestAiModule } from '@nestjs/ai';
import { MODERATION_MODEL } from './guardrails/guardrail.js';
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_MODERATION_MODEL,
} from './models.js';
import {
  aiModels,
  chatProviderOrder,
  moderationProviderOrder,
} from './providers/provider-registry.js';
import type { ReasoningEffort } from './reasoning.js';
import { AiTelemetryModule } from './telemetry/ai-telemetry.module.js';
import { AiCostTransportService } from './telemetry/ai-cost-transport.service.js';
import { runtimeConfig } from '../config/runtime-config.js';

@Global()
@Module({
  imports: [
    AiTelemetryModule,
    NestAiModule.forRootAsync({
      isGlobal: true,
      modelNames: ['default', 'blog'],
      embeddingModelNames: ['default', 'posts'],
      imports: [AiTelemetryModule],
      inject: [ConfigService, AiCostTransportService],
      useFactory: (config: ConfigService, costs: AiCostTransportService) => {
        const models = aiModels(config);
        const defaultModelId = config.get<string>(
          'AI_CHAT_MODEL',
          DEFAULT_CHAT_MODEL,
        );
        const reasoningEffort = config.get<ReasoningEffort>(
          'AI_REASONING_EFFORT',
          'low',
        );
        const providerOrder = chatProviderOrder(config);
        const blogModelId =
          config.get<string>('BLOG_AI_MODEL') || defaultModelId;
        const knowledgeEmbeddingModelId = config.get<string>(
          'AI_EMBEDDING_MODEL',
          DEFAULT_EMBEDDING_MODEL,
        );
        const postsEmbeddingModelId = config.get<string>(
          'POST_SEARCH_EMBEDDING_MODEL',
          DEFAULT_EMBEDDING_MODEL,
        );
        return {
          models: {
            default: models.chat(defaultModelId, {
              effort: reasoningEffort,
              providerOrder,
              fetch: costs.forModel(defaultModelId),
            }),
            blog: models.chat(blogModelId, {
              effort: reasoningEffort,
              providerOrder,
              fetch: costs.forModel(blogModelId),
            }),
          },
          embeddingModels: {
            default: models.embedding(knowledgeEmbeddingModelId, {
              dimensions: config.get<number>(
                'KNOWLEDGE_EMBEDDING_DIMENSIONS',
                1536,
              ),
              fetch: costs.forModel(knowledgeEmbeddingModelId, 'KNOWLEDGE'),
            }),
            posts: {
              model: models.embedding(postsEmbeddingModelId, {
                dimensions: config.get<number>(
                  'POST_SEARCH_EMBEDDING_DIMENSIONS',
                  768,
                ),
                fetch: costs.forModel(postsEmbeddingModelId, 'POSTS'),
              }),
              timeout: runtimeConfig.POST_SEARCH_EMBED_TIMEOUT_MS,
            },
          },
        };
      },
    }),
  ],
  providers: [
    {
      provide: MODERATION_MODEL,
      inject: [ConfigService, AiCostTransportService],
      useFactory: (config: ConfigService, costs: AiCostTransportService) => {
        const modelId = config.get<string>(
          'AI_MODERATION_MODEL',
          DEFAULT_MODERATION_MODEL,
        );
        // The request's cost context (chat or blog assistant) names the feature.
        return aiModels(config).chat(modelId, {
          effort: 'low',
          providerOrder: moderationProviderOrder(config),
          fetch: costs.forModel(modelId, 'SYSTEM', 'MODERATION'),
        });
      },
    },
  ],
  exports: [MODERATION_MODEL],
})
export class AiModule {}
