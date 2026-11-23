import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  activeChatModel,
  activeChatModelId,
  activeEvaluationModel,
} from '../ai/provider.js';
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
        activeEvaluationModel(config, costs, true),
    },
    {
      provide: MODERATION_EVIDENCE_MODEL,
      inject: [ConfigService, AiCostTransportService],
      useFactory: (
        config: ConfigService,
        costs: AiCostTransportService,
      ): EvidenceModel => {
        const id = activeChatModelId(config, 'evidence');
        const model = activeChatModel(config, costs, 'evidence');
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
