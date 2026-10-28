import { Module } from '@nestjs/common';
import { AiUsageModule } from '../ai/usage/ai-usage.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { MediaModule } from '../media/media.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminPostsController } from './admin/admin-posts.controller';
import { AdminPostsService } from './admin/admin-posts.service';
import { AdminReportsController } from './admin/admin-reports.controller';
import { BlogAssistantService } from './blogs/ai/blog-assistant.service';
import { BlogImageGeneratorService } from './blogs/ai/blog-image-generator.service';
import { BlogAiController } from './blogs/blog-ai.controller';
import { BlogImagesService } from './blogs/blog-images.service';
import { BlogsController } from './blogs/blogs.controller';
import { BlogsService } from './blogs/blogs.service';
import { PostInteractionsController } from './interactions/post-interactions.controller';
import { PostInteractionsService } from './interactions/post-interactions.service';
import { PostReportsService } from './interactions/post-reports.service';
import { PostSearchModule } from './search/post-search.module';
import { PostRelationsService } from './post-relations.service';
import { PostViewsService } from './post-views.service';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

@Module({
  imports: [
    MediaModule,
    PostSearchModule,
    NotificationsModule,
    KnowledgeModule,
    AiUsageModule,
  ],
  controllers: [
    BlogAiController,
    BlogsController,
    PostsController,
    PostInteractionsController,
    AdminPostsController,
    AdminReportsController,
  ],
  providers: [
    BlogsService,
    BlogImagesService,
    BlogAssistantService,
    BlogImageGeneratorService,
    PostsService,
    PostRelationsService,
    PostInteractionsService,
    AdminPostsService,
    PostReportsService,
    PostViewsService,
  ],
})
export class PostsModule {}
