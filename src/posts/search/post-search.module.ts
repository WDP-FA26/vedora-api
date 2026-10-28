import { Module } from '@nestjs/common';
import { PostEmbeddingsService } from './post-embeddings.service.js';
import { PostFeedService } from './post-feed.service.js';
import { PostSearchIndexService } from './post-search-index.service.js';
import { PostSearchService } from './post-search.service.js';

/**
 * Post search and the "for you" feed, over their own Qdrant collection,
 * separate from the knowledge base.
 */
@Module({
  providers: [
    PostEmbeddingsService,
    PostSearchIndexService,
    PostSearchService,
    PostFeedService,
  ],
  exports: [PostSearchIndexService, PostSearchService, PostFeedService],
})
export class PostSearchModule {}
