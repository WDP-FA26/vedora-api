import { Module } from '@nestjs/common';
import { PostEmbeddingsService } from './post-embeddings.service';
import { PostSearchIndexService } from './post-search-index.service';
import { PostSearchService } from './post-search.service';

/** Post search in its own Qdrant collection, separate from the knowledge base. */
@Module({
  providers: [PostEmbeddingsService, PostSearchIndexService, PostSearchService],
  exports: [PostSearchIndexService, PostSearchService],
})
export class PostSearchModule {}
