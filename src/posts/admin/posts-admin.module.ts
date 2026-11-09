import { Module } from '@nestjs/common';
import { MediaModule } from '../../media/media.module.js';
import { PostInteractionsModule } from '../interactions/post-interactions.module.js';
import { PostsModule } from '../posts.module.js';
import { AdminPostsController } from './admin-posts.controller.js';
import { AdminPostsService } from './admin-posts.service.js';
import { AdminReportsController } from './admin-reports.controller.js';

@Module({
  imports: [PostsModule, PostInteractionsModule, MediaModule],
  controllers: [AdminPostsController, AdminReportsController],
  providers: [AdminPostsService],
})
export class PostsAdminModule {}
