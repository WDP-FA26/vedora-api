import { Module } from '@nestjs/common';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module.js';
import { KnowledgeModule } from '../../knowledge/knowledge.module.js';
import { MediaModule } from '../../media/media.module.js';
import { PostsModule } from '../posts.module.js';
import { BlogAssistantService } from './ai/blog-assistant.service.js';
import { BlogImageGeneratorService } from './ai/blog-image-generator.service.js';
import { BlogAiController } from './blog-ai.controller.js';
import { BlogImagesService } from './blog-images.service.js';
import { BlogsController } from './blogs.controller.js';
import { BlogsService } from './blogs.service.js';

@Module({
  imports: [PostsModule, MediaModule, KnowledgeModule, SubscriptionsModule],
  controllers: [BlogAiController, BlogsController],
  providers: [
    BlogsService,
    BlogImagesService,
    BlogAssistantService,
    BlogImageGeneratorService,
  ],
})
export class BlogsModule {}
