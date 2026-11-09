import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { PostRelationsService } from './post-relations.service.js';
import { PostViewsService } from './post-views.service.js';
import { PostsQueryService } from './posts-query.service.js';
import { PostsController } from './posts.controller.js';
import { PostsService } from './posts.service.js';
import { PostSearchModule } from './search/post-search.module.js';

@Module({
  imports: [MediaModule, PostSearchModule],
  controllers: [PostsController],
  providers: [
    PostsService,
    PostsQueryService,
    PostRelationsService,
    PostViewsService,
  ],
  exports: [PostsService, PostsQueryService, PostRelationsService],
})
export class PostsModule {}
