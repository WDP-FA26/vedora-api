import { Module } from '@nestjs/common';
import { PostEmbeddingsService } from './post-embeddings.service';
import { PostFeedService } from './post-feed.service';
import { PostSearchIndexService } from './post-search-index.service';
import { PostSearchService } from './post-search.service';

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
