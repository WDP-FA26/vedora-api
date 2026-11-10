import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiTelemetryModule } from '../ai/telemetry/ai-telemetry.module.js';
import { AdminAiCostsController } from './admin-ai-costs.controller.js';
import { AdminAiCostsService } from './admin-ai-costs.service.js';

@Module({
  imports: [ConfigModule, AiTelemetryModule],
  controllers: [AdminAiCostsController],
  providers: [AdminAiCostsService],
})
export class AdminAiCostsModule {}
