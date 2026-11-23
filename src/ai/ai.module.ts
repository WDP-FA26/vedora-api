import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiModule as NestAiModule } from '@nestjs/ai';
import { MODERATION_MODEL } from './guardrails/guardrail.js';
import {
  activeChatModel,
  activeEmbeddingModel,
  activeEvaluationModel,
} from './provider.js';
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
      useFactory: (config: ConfigService, costs: AiCostTransportService) => ({
        models: {
          default: activeChatModel(config, costs),
          blog: activeChatModel(config, costs, 'blog'),
        },
        embeddingModels: {
          default: activeEmbeddingModel(config, costs),
          posts: {
            model: activeEmbeddingModel(config, costs, true),
            timeout: runtimeConfig.POST_SEARCH_EMBED_TIMEOUT_MS,
          },
        },
      }),
    }),
  ],
  providers: [
    {
      provide: MODERATION_MODEL,
      inject: [ConfigService, AiCostTransportService],
      useFactory: (config: ConfigService, costs: AiCostTransportService) =>
        activeEvaluationModel(config, costs),
    },
  ],
  exports: [MODERATION_MODEL],
})
export class AiModule {}
