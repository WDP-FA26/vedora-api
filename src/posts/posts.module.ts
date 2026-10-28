import { Module } from '@nestjs/common';
import { AiUsageModule } from '../ai/usage/ai-usage.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { MediaModule } from '../media/media.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AdminPostsController } from './admin/admin-posts.controller.js';
import { AdminPostsService } from './admin/admin-posts.service.js';
import { AdminReportsController } from './admin/admin-reports.controller.js';
import { BlogAssistantService } from './blogs/ai/blog-assistant.service.js';
import { BlogImageGeneratorService } from './blogs/ai/blog-image-generator.service.js';
import { BlogAiController } from './blogs/blog-ai.controller.js';
import { BlogImagesService } from './blogs/blog-images.service.js';
import { BlogsController } from './blogs/blogs.controller.js';
import { BlogsService } from './blogs/blogs.service.js';
import { PostInteractionsController } from './interactions/post-interactions.controller.js';
import { PostInteractionsService } from './interactions/post-interactions.service.js';
import { PostReportsService } from './interactions/post-reports.service.js';
import { PostSearchModule } from './search/post-search.module.js';
import { PostRelationsService } from './post-relations.service.js';
import { PostViewsService } from './post-views.service.js';
import { PostsController } from './posts.controller.js';
import { PostsService } from './posts.service.js';

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
