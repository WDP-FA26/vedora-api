import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AiCostContextInterceptor } from './ai-cost-context.js';
import { AiCostTransportService } from './ai-cost-transport.service.js';

@Global()
@Module({
  providers: [
    AiCostTransportService,
    { provide: APP_INTERCEPTOR, useClass: AiCostContextInterceptor },
  ],
  exports: [AiCostTransportService],
})
export class AiTelemetryModule {}
