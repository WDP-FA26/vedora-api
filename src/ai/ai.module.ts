import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiModule as NestAiModule } from '@nestjs/ai';
import { evaluationModel } from '../common/decision/decision.js';
import { MODERATION_MODEL } from './guardrails/guardrail.js';
import {
  chatModel,
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_MODERATION_MODEL,
  embeddingModel,
} from './openrouter.js';
import type { ReasoningEffort } from './reasoning.js';
import { AiTelemetryModule } from './telemetry/ai-telemetry.module.js';
import { AiCostTransportService } from './telemetry/ai-cost-transport.service.js';

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
              fetch: costs.forModel(defaultModelId),
            }),
            blog: chatModel({
              apiKey,
              modelId: config.get<string>('BLOG_AI_MODEL') || defaultModelId,
              reasoningEffort,
              fetch: costs.forModel(
                config.get<string>('BLOG_AI_MODEL') || defaultModelId,
              ),
            }),
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
              fetch: costs.forModel(DEFAULT_EMBEDDING_MODEL, 'KNOWLEDGE'),
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
                fetch: costs.forModel(DEFAULT_EMBEDDING_MODEL, 'POSTS'),
              }),
              timeout: '30s',
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
      useFactory: (config: ConfigService, costs: AiCostTransportService) =>
        evaluationModel({
          apiKey: config.getOrThrow<string>('OPENROUTER_API_KEY'),
          modelId: config.get<string>(
            'OPENROUTER_MODERATION_MODEL',
            DEFAULT_MODERATION_MODEL,
          ),
          fetch: costs.forModel(DEFAULT_MODERATION_MODEL, 'CONTENT_MODERATION'),
        }),
    },
  ],
  exports: [MODERATION_MODEL],
})
export class AiModule {}
