import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_CONTENT_MODERATION_MODEL } from '../ai/models.js';
import {
  aiModels,
  moderationProviderOrder,
} from '../ai/providers/provider-registry.js';
import { AdminModerationController } from './admin-moderation.controller.js';
import {
  CONTENT_MODERATION_MODEL,
  ContentModerationService,
  type ModerationModel,
} from './content-moderation.service.js';
import { ModerationSettingsService } from './moderation-settings.service.js';
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
      useFactory: (
        config: ConfigService,
        costs: AiCostTransportService,
      ): ModerationModel => {
        const id = config.get<string>(
          'AI_CONTENT_MODERATION_MODEL',
          DEFAULT_CONTENT_MODERATION_MODEL,
        );
        const model = aiModels(config).chat(id, {
          effort: 'medium',
          providerOrder: moderationProviderOrder(config),
          fetch: costs.forModel(id, 'CONTENT_MODERATION', 'MODERATION'),
        });
        return { id, model };
      },
    },
    ModerationSettingsService,
    ContentModerationService,
  ],
  exports: [ContentModerationService, ModerationSettingsService],
})
export class ModerationModule {}
