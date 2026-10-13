import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { AdminPostsController } from './admin-posts.controller';
import { AdminReportsController } from './admin-reports.controller';
import { AdminPostsService } from './admin-posts.service';
import { PostInteractionsController } from './post-interactions.controller';
import { PostInteractionsService } from './post-interactions.service';
import { PostReportsService } from './post-reports.service';
import { PostViewsService } from './post-views.service';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { BlogsController } from './blogs.controller';
import { BlogsService } from './blogs.service';

@Module({
  imports: [MediaModule],
  controllers: [
    BlogsController,
    PostsController,
    PostInteractionsController,
    AdminPostsController,
    AdminReportsController,
  ],
  providers: [
    BlogsService,
    PostsService,
    PostInteractionsService,
    AdminPostsService,
    PostReportsService,
    PostViewsService,
  ],
})
export class PostsModule {}
