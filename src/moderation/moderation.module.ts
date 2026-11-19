import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  chatModel,
  DEFAULT_CONTENT_MODERATION_MODEL,
  DEFAULT_MODERATION_EVIDENCE_MODEL,
} from '../ai/openrouter.js';
import { evaluationModel } from '../common/decision/decision.js';
import { AdminModerationController } from './admin-moderation.controller.js';
import {
  CONTENT_MODERATION_MODEL,
  ContentModerationService,
} from './content-moderation.service.js';
import { ModerationSettingsService } from './moderation-settings.service.js';
import {
  ContentEvidenceService,
  type EvidenceModel,
  MODERATION_EVIDENCE_MODEL,
} from './content-evidence.service.js';
import { AiTelemetryModule } from '../ai/telemetry/ai-telemetry.module.js';
import { AiCostTransportService } from '../ai/telemetry/ai-cost-transport.service.js';

@Global()
@Module({
  imports: [AiTelemetryModule],
  controllers: [AdminModerationController],
  providers: [
    {
      provide: CONTENT_MODERATION_MODEL,
      inject: [ConfigService, AiCostTransportService],
      useFactory: (config: ConfigService, costs: AiCostTransportService) =>
        evaluationModel({
          apiKey: config.getOrThrow<string>('OPENROUTER_API_KEY'),
          modelId: config.get<string>(
            'OPENROUTER_CONTENT_MODERATION_MODEL',
            DEFAULT_CONTENT_MODERATION_MODEL,
          ),
          fetch: costs.forModel(
            DEFAULT_CONTENT_MODERATION_MODEL,
            'CONTENT_MODERATION',
          ),
        }),
    },
    {
      provide: MODERATION_EVIDENCE_MODEL,
      inject: [ConfigService, AiCostTransportService],
      useFactory: (
        config: ConfigService,
        costs: AiCostTransportService,
      ): EvidenceModel => {
        const id = config.get<string>(
          'OPENROUTER_MODERATION_EVIDENCE_MODEL',
          DEFAULT_MODERATION_EVIDENCE_MODEL,
        );
        const model = chatModel({
          apiKey: config.getOrThrow<string>('OPENROUTER_API_KEY'),
          modelId: id,
          fetch: costs.forModel(id, 'CONTENT_MODERATION'),
        });
        return { id, model };
      },
    },
    ModerationSettingsService,
    ContentModerationService,
    ContentEvidenceService,
  ],
  exports: [
    ContentModerationService,
    ModerationSettingsService,
    ContentEvidenceService,
  ],
})
export class ModerationModule {}
