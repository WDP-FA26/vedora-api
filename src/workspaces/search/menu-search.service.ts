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

/** Up to this many words, a dish must share a word with the query. */
export const SHORT_QUERY_MAX_WORDS = 2;

/** "cơm", "bánh mì": a dish name rather than a description. */
export function isShortQuery(query: string): boolean {
  return query.trim().split(/\s+/).length <= SHORT_QUERY_MAX_WORDS;
}

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

    const lexical = [
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
    const page = { offset, limit: limit + 1, with_payload: false };

    let request: Parameters<QdrantService['query']>[1];
    if (dense === null) {
      request = { ...page, prefetch: lexical, query: { fusion: 'rrf' } };
    } else if (isShortQuery(trimmed)) {
      // One or two words: every Vietnamese dish is "close" in meaning to
      // "cơm" or "chè", so meaning alone pulled in dishes that share no word
      // with the query. Keep the dishes that share a word, ranked by meaning.
      request = {
        ...page,
        prefetch: lexical,
        query: dense,
        using: MENU_DENSE_VECTOR,
      };
    } else {
      // A longer query ("món nước thanh đạm") describes the dish; meaning may
      // find dishes that share no word with it.
      const semantic = {
        query: dense,
        using: MENU_DENSE_VECTOR,
        limit: MAX_MENU_SEARCH_RESULTS,
        score_threshold: this.minScore,
      };
      request = {
        ...page,
        prefetch: [semantic, ...lexical],
        query: { fusion: 'rrf' },
      };
    }

    const { points } = await this.qdrant.query(this.index.collection, request);
    const ids = points.map(({ id }) => String(id));
    return { ids: ids.slice(0, limit), hasMore: ids.length > limit };
  }

  prune(itemIds: string[]): Promise<void> {
    return this.index.removeMany(itemIds);
  }
}
