import { Module } from '@nestjs/common';
import { PostAnalyticsController } from './post-analytics.controller.js';
import { PostAnalyticsService } from './post-analytics.service.js';

@Module({
  controllers: [PostAnalyticsController],
  providers: [PostAnalyticsService],
})
export class PostAnalyticsModule {}
