import { runtimeConfig } from '../../config/runtime-config.js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '@nestjs/ai';
import { QdrantService } from '../../qdrant/qdrant.service.js';
import {
  MENU_BM25_FOLDED_VECTOR,
  MENU_BM25_VECTOR,
  MENU_DENSE_VECTOR,
  menuBm25,
} from './menu-search-collection.js';
import { MenuSearchIndexService } from './menu-search-index.service.js';

export const MAX_MENU_SEARCH_RESULTS = runtimeConfig.POST_SEARCH_MAX_RESULTS;

export interface MenuSearchPage {
  ids: string[];
  hasMore: boolean;
}

@Injectable()
export class MenuSearchService {
  private readonly logger = new Logger(MenuSearchService.name);
  private readonly minScore: number;

  constructor(
    private readonly qdrant: QdrantService,
    private readonly ai: AiService,
    private readonly index: MenuSearchIndexService,
    configService: ConfigService,
  ) {
    this.minScore = configService.get<number>('POST_SEARCH_MIN_SCORE', 0.65);
  }

  async search(
    query: string,
    offset: number,
    limit: number,
  ): Promise<MenuSearchPage> {
    const trimmed = query.trim();
    if (!trimmed) return { ids: [], hasMore: false };

    await this.index.ensureCollection();

    let dense: number[] | null = null;
    try {
      const { embedding } = await this.ai.embed({
        model: 'posts',
        label: 'search-menu-items',
        value: `task: search result | query: ${trimmed}`,
      });
      dense = embedding;
    } catch (error) {
      this.logger.warn(
        `Menu query embedding failed, falling back to BM25: ${String(error)}`,
      );
    }

    const prefetch = [
      ...(dense
        ? [
            {
              query: dense,
              using: MENU_DENSE_VECTOR,
              limit: MAX_MENU_SEARCH_RESULTS,
              score_threshold: this.minScore,
            },
          ]
        : []),
      {
        query: menuBm25(trimmed, false),
        using: MENU_BM25_VECTOR,
        limit: MAX_MENU_SEARCH_RESULTS,
      },
      {
        query: menuBm25(trimmed, true),
        using: MENU_BM25_FOLDED_VECTOR,
        limit: MAX_MENU_SEARCH_RESULTS,
      },
    ];

    const { points } = await this.qdrant.query(this.index.collection, {
      prefetch,
      query: { fusion: 'rrf' },
      offset,
      limit: limit + 1,
      with_payload: false,
    });
    const ids = points.map(({ id }) => String(id));
    return { ids: ids.slice(0, limit), hasMore: ids.length > limit };
  }

  prune(itemIds: string[]): Promise<void> {
    return this.index.removeMany(itemIds);
  }
}
