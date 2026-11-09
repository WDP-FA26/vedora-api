import { Module } from '@nestjs/common';
import { NotificationsModule } from '../../notifications/notifications.module.js';
import { PostInteractionsController } from './post-interactions.controller.js';
import { PostInteractionsService } from './post-interactions.service.js';
import { PostReportsService } from './post-reports.service.js';

@Module({
  imports: [NotificationsModule],
  controllers: [PostInteractionsController],
  providers: [PostInteractionsService, PostReportsService],
  exports: [PostReportsService],
})
export class PostInteractionsModule {}
