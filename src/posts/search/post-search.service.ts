import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '@nestjs/ai';
import { QdrantService } from '../../qdrant/qdrant.service.js';
import {
  BM25_FOLDED_VECTOR,
  BM25_VECTOR,
  bm25,
  DENSE_VECTOR,
} from './post-search-collection.js';
import { PostSearchIndexService } from './post-search-index.service.js';

export const MAX_SEARCH_RESULTS = 200;

export interface PostSearchPage {
  ids: string[];
  hasMore: boolean;
}

@Injectable()
export class PostSearchService {
  private readonly minScore: number;

  constructor(
    private readonly qdrant: QdrantService,
    private readonly ai: AiService,
    private readonly index: PostSearchIndexService,
    configService: ConfigService,
  ) {
    this.minScore = configService.get<number>('POST_SEARCH_MIN_SCORE', 0.65);
  }

  async search(
    query: string,
    offset: number,
    limit: number,
  ): Promise<PostSearchPage> {
    await this.index.ensureCollection();
    const { embedding: dense } = await this.ai.embed({
      model: 'posts',
      label: 'search-posts',
      value: `task: search result | query: ${query}`,
    });
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

  prune(postIds: string[]): Promise<void> {
    return this.index.removeMany(postIds);
  }
}
