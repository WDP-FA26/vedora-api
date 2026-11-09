import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { PostRelationsService } from './post-relations.service.js';
import { PostViewsService } from './post-views.service.js';
import { PostsController } from './posts.controller.js';
import { PostsService } from './posts.service.js';
import { PostSearchModule } from './search/post-search.module.js';

@Module({
  imports: [MediaModule, PostSearchModule],
  controllers: [PostsController],
  providers: [PostsService, PostRelationsService, PostViewsService],
  exports: [PostsService, PostRelationsService],
})
export class PostsModule {}
