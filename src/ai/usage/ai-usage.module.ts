import { Module } from '@nestjs/common';
import { AiUsageService } from './ai-usage.service';

@Module({
  providers: [AiUsageService],
  exports: [AiUsageService],
})
export class AiUsageModule {}
