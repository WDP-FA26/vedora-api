import { Module } from '@nestjs/common';
import { NotificationsModule } from '../../notifications/notifications.module.js';
import { PostInteractionsController } from './post-interactions.controller.js';
import { PostInteractionsService } from './post-interactions.service.js';
import { PostReportsService } from './post-reports.service.js';
import { CommentReportsService } from './comment-reports.service.js';
import { CommentReportsController } from './comment-reports.controller.js';

@Module({
  imports: [NotificationsModule],
  controllers: [PostInteractionsController, CommentReportsController],
  providers: [PostInteractionsService, PostReportsService, CommentReportsService],
  exports: [PostReportsService, CommentReportsService],
})
export class PostInteractionsModule {}
