import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantService } from '../qdrant/qdrant.service';
import { PostEmbeddingsService } from './post-embeddings.service';
import {
  BM25_FOLDED_VECTOR,
  BM25_VECTOR,
  bm25,
  DENSE_VECTOR,
} from './post-search-collection';
import { PostSearchIndexService } from './post-search-index.service';

/** How deep search pages may go; each prefetch fetches this many. */
export const MAX_SEARCH_RESULTS = 200;

export interface PostSearchPage {
  /** Post ids, best match first. */
  ids: string[];
  hasMore: boolean;
}

/** Hybrid search (meaning + keywords, fused with RRF) over published posts. */
@Injectable()
export class PostSearchService {
  private readonly minScore: number;

  constructor(
    private readonly qdrant: QdrantService,
    private readonly embeddings: PostEmbeddingsService,
    private readonly index: PostSearchIndexService,
    configService: ConfigService,
  ) {
    // With gemini-embedding-2 at 768 dimensions, unrelated queries ("laptop
    // gaming") still score 0.55–0.65 against cooking posts and real matches
    // 0.7+. Keyword matches count however low their meaning score is.
    this.minScore = configService.get<number>('POST_SEARCH_MIN_SCORE', 0.65);
  }

  async search(
    query: string,
    offset: number,
    limit: number,
  ): Promise<PostSearchPage> {
    await this.index.ensureCollection();
    const dense = await this.embeddings.embedQuery(query);
    const { points } = await this.qdrant.query(this.index.collection, {
      prefetch: [
        {
          query: dense,
          using: DENSE_VECTOR,
          limit: MAX_SEARCH_RESULTS,
          score_threshold: this.minScore,
        },
        {
          query: bm25(query, false),
          using: BM25_VECTOR,
          limit: MAX_SEARCH_RESULTS,
        },
        {
          query: bm25(query, true),
          using: BM25_FOLDED_VECTOR,
          limit: MAX_SEARCH_RESULTS,
        },
      ],
      query: { fusion: 'rrf' },
      offset,
      limit: limit + 1,
      with_payload: false,
    });
    const ids = points.map(({ id }) => String(id));
    return { ids: ids.slice(0, limit), hasMore: ids.length > limit };
  }

  /** Drops points whose post no longer exists. */
  prune(postIds: string[]): Promise<void> {
    return this.index.removeMany(postIds);
  }
}
