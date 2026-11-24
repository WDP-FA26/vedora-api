import { Module } from '@nestjs/common';
import { NotificationsModule } from '../../notifications/notifications.module.js';
import { PostInteractionsController } from './post-interactions.controller.js';
import { PostInteractionsService } from './post-interactions.service.js';
import { PostReportsService } from './post-reports.service.js';
import { CommentReportsService } from './comment-reports.service.js';
import { CommentReportsController } from './comment-reports.controller.js';
import { PostReportEvidenceController } from './post-report-evidence.controller.js';
import { PostReportEvidenceService } from './post-report-evidence.service.js';

@Module({
  imports: [NotificationsModule],
  controllers: [
    PostInteractionsController,
    CommentReportsController,
    PostReportEvidenceController,
  ],
  providers: [
    PostInteractionsService,
    PostReportsService,
    CommentReportsService,
    PostReportEvidenceService,
  ],
  exports: [PostReportsService, CommentReportsService],
})
export class PostInteractionsModule {}
