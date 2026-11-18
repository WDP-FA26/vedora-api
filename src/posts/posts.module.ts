import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { PostRelationsService } from './post-relations.service.js';
import { PostViewsService } from './post-views.service.js';
import { PostsQueryService } from './posts-query.service.js';
import { PostsController } from './posts.controller.js';
import { PostsService } from './posts.service.js';
import { PostDraftsService } from './post-drafts.service.js';
import { PostDraftsController } from './post-drafts.controller.js';
import { PostSearchModule } from './search/post-search.module.js';

@Module({
  imports: [MediaModule, PostSearchModule],
  controllers: [PostDraftsController, PostsController],
  providers: [
    PostsService,
    PostDraftsService,
    PostsQueryService,
    PostRelationsService,
    PostViewsService,
  ],
  exports: [PostsService, PostsQueryService, PostRelationsService],
})
export class PostsModule {}
