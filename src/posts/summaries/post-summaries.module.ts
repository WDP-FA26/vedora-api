import { Module } from '@nestjs/common';
import { CaptionsModule } from '../../media/captions/captions.module.js';
import { PostSummariesController } from './post-summaries.controller.js';
import { PostSummariesService } from './post-summaries.service.js';
import { PostSummaryGenerator } from './post-summary.generator.js';

@Module({
  imports: [CaptionsModule],
  controllers: [PostSummariesController],
  providers: [PostSummariesService, PostSummaryGenerator],
  exports: [PostSummariesService],
})
export class PostSummariesModule {}
