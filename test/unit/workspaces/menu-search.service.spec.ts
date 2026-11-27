import type { AiService } from '@nestjs/ai';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { QdrantService } from '@src/qdrant/qdrant.service.js';
import {
  MENU_BM25_FOLDED_VECTOR,
  MENU_BM25_VECTOR,
  MENU_DENSE_VECTOR,
} from '@src/workspaces/search/menu-search-collection.js';
import type { MenuSearchIndexService } from '@src/workspaces/search/menu-search-index.service.js';
import {
  isShortQuery,
  MenuSearchService,
} from '@src/workspaces/search/menu-search.service.js';

const VECTOR = [0.1, 0.2, 0.3];

function setup(embedding: 'ok' | 'fails' = 'ok') {
  const qdrant = mockDeep<QdrantService>();
  qdrant.query.mockResolvedValue({
    points: [{ id: 'a', version: 0, score: 1 }],
  });
  const ai = mockDeep<AiService>();
  if (embedding === 'ok') {
    ai.embed.mockResolvedValue(
      mockDeep<Awaited<ReturnType<AiService['embed']>>>({ embedding: VECTOR }),
    );
  } else {
    ai.embed.mockRejectedValue(new Error('provider down'));
  }
  const index = mockDeep<MenuSearchIndexService>({ collection: 'menu' });
  const config = new ConfigService({ POST_SEARCH_MIN_SCORE: 0.65 });
  const service = new MenuSearchService(qdrant, ai, index, config);
  return { service, qdrant };
}

function sentRequest(qdrant: ReturnType<typeof setup>['qdrant']) {
  const call = qdrant.query.mock.calls[0];
  expect(call).toBeDefined();
  return call[1];
}

function usedVectors(prefetch: unknown): string[] {
  if (!Array.isArray(prefetch)) return [];
  const names: string[] = [];
  for (const item of prefetch) {
    const using: unknown = Reflect.get(Object(item), 'using');
    if (typeof using === 'string') names.push(using);
  }
  return names;
}

describe('isShortQuery', () => {
  it('counts words, not characters', () => {
    expect(isShortQuery('cơm')).toBe(true);
    expect(isShortQuery('  bánh   mì ')).toBe(true);
    expect(isShortQuery('món nước thanh đạm')).toBe(false);
  });
});

describe('MenuSearchService.search', () => {
  it('keeps only dishes sharing a word with a short query, ranked by meaning', async () => {
    const { service, qdrant } = setup();
    await service.search('cơm', 0, 4);
    const request = sentRequest(qdrant);
    expect(usedVectors(request.prefetch)).toEqual([
      MENU_BM25_VECTOR,
      MENU_BM25_FOLDED_VECTOR,
    ]);
    expect(request).toMatchObject({ query: VECTOR, using: MENU_DENSE_VECTOR });
  });

  it('lets meaning find dishes for a longer description', async () => {
    const { service, qdrant } = setup();
    await service.search('món nước thanh đạm', 0, 4);
    const request = sentRequest(qdrant);
    expect(usedVectors(request.prefetch)).toEqual([
      MENU_DENSE_VECTOR,
      MENU_BM25_VECTOR,
      MENU_BM25_FOLDED_VECTOR,
    ]);
    expect(request.query).toEqual({ fusion: 'rrf' });
  });

  it('falls back to keywords when the query cannot be embedded', async () => {
    const { service, qdrant } = setup('fails');
    const page = await service.search('món nước thanh đạm', 0, 4);
    const request = sentRequest(qdrant);
    expect(usedVectors(request.prefetch)).toEqual([
      MENU_BM25_VECTOR,
      MENU_BM25_FOLDED_VECTOR,
    ]);
    expect(request.query).toEqual({ fusion: 'rrf' });
    expect(page).toEqual({ ids: ['a'], hasMore: false });
  });
});
