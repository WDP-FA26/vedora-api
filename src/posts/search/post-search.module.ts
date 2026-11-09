import { Module } from '@nestjs/common';
import { PostFeedService } from './post-feed.service.js';
import { PostSearchIndexService } from './post-search-index.service.js';
import { PostSearchService } from './post-search.service.js';

@Module({
  providers: [PostSearchIndexService, PostSearchService, PostFeedService],
  exports: [PostSearchIndexService, PostSearchService, PostFeedService],
})
export class PostSearchModule {}
