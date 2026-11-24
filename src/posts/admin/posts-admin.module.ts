import { Module } from '@nestjs/common';
import { SupportCoreModule } from '../../support/support-core.module.js';
import { MediaModule } from '../../media/media.module.js';
import { NotificationsModule } from '../../notifications/notifications.module.js';
import { PostInteractionsModule } from '../interactions/post-interactions.module.js';
import { PostsModule } from '../posts.module.js';
import { PostSearchModule } from '../search/post-search.module.js';
import { AdminPostsController } from './admin-posts.controller.js';
import { AdminPostsService } from './admin-posts.service.js';
import { AdminReportsController } from './admin-reports.controller.js';

@Module({
  imports: [
    PostsModule,
    PostInteractionsModule,
    MediaModule,
    PostSearchModule,
    NotificationsModule,
    SupportCoreModule,
  ],
  controllers: [
    AdminPostsController,
    AdminReportsController,
  ],
  providers: [AdminPostsService],
  exports: [AdminPostsService],
})
export class PostsAdminModule {}
