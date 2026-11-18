import { runtimeConfig } from '../../config/runtime-config.js';
import { Injectable } from '@nestjs/common';
import { QdrantService } from '../../qdrant/qdrant.service.js';
import {
  BIO_BM25_FOLDED_VECTOR,
  BIO_BM25_VECTOR,
  IDENTITY_BM25_FOLDED_VECTOR,
  IDENTITY_BM25_VECTOR,
  IDENTITY_PREFIX_VECTOR,
  normalizeProfileQuery,
  profileBm25,
} from './profile-search-collection.js';
import { ProfileSearchIndexService } from './profile-search-index.service.js';

export const MAX_PROFILE_SEARCH_RESULTS = runtimeConfig.POST_SEARCH_MAX_RESULTS;

export interface ProfileSearchPage {
  ids: string[];
  hasMore: boolean;
}

@Injectable()
export class ProfileSearchService {
  constructor(
    private readonly qdrant: QdrantService,
    private readonly index: ProfileSearchIndexService,
  ) {}

  async search(
    query: string,
    offset: number,
    limit: number,
  ): Promise<ProfileSearchPage> {
    const normalized = normalizeProfileQuery(query);
    if (!normalized) return { ids: [], hasMore: false };

    await this.index.ensureCollection();
    const { points } = await this.qdrant.query(this.index.collection, {
      prefetch: [
        {
          query: profileBm25(normalized, false),
          using: IDENTITY_BM25_VECTOR,
          limit: MAX_PROFILE_SEARCH_RESULTS,
        },
        {
          query: profileBm25(normalized, true),
          using: IDENTITY_BM25_FOLDED_VECTOR,
          limit: MAX_PROFILE_SEARCH_RESULTS,
        },
        {
          query: profileBm25(normalized, true),
          using: IDENTITY_PREFIX_VECTOR,
          limit: MAX_PROFILE_SEARCH_RESULTS,
        },
        {
          query: profileBm25(normalized, false),
          using: BIO_BM25_VECTOR,
          limit: MAX_PROFILE_SEARCH_RESULTS,
        },
        {
          query: profileBm25(normalized, true),
          using: BIO_BM25_FOLDED_VECTOR,
          limit: MAX_PROFILE_SEARCH_RESULTS,
        },
      ],
      query: { rrf: { weights: [4, 3, 2, 1, 1] } },
      offset,
      limit: limit + 1,
      with_payload: false,
    });
    const ids = points.map(({ id }) => String(id));
    return { ids: ids.slice(0, limit), hasMore: ids.length > limit };
  }

  prune(userIds: string[]): Promise<void> {
    return this.index.removeMany(userIds);
  }
}
