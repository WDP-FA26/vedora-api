import { Injectable, Logger } from '@nestjs/common';
import { parsePayload } from '../../common/validation.js';
import { QdrantService } from '../../qdrant/qdrant.service.js';
import {
  BM25_FOLDED_VECTOR,
  BM25_VECTOR,
  bm25,
  DENSE_VECTOR,
  KnowledgePointPayload,
} from './knowledge-collection.js';
import { KnowledgeIndexService } from './knowledge-index.service.js';
import {
  KnowledgeModelsService,
  type RerankResult,
} from './knowledge-models.service.js';

const PREFETCH_LIMIT = 40;
const CANDIDATES = 20;
const RESULTS = 6;
// Cohere scores off-topic questions below ~0.03, but a Vietnamese question
// against an English passage only 0.08–0.3 even when it answers it
const MIN_RELEVANCE = 0.08;
const RERANK_BUDGET_MS = 800;

export type KnowledgeHit = Pick<
  KnowledgePointPayload,
  'title' | 'page' | 'text'
>;

@Injectable()
export class KnowledgeSearchService {
  private readonly logger = new Logger(KnowledgeSearchService.name);

  constructor(
    private readonly qdrant: QdrantService,
    private readonly models: KnowledgeModelsService,
    private readonly index: KnowledgeIndexService,
  ) {}

  async search(query: string, signal?: AbortSignal): Promise<KnowledgeHit[]> {
    const dense = await this.models.embedQuery(query, signal);
    const { points } = await this.qdrant.query(this.index.collection, {
      prefetch: [
        { query: dense, using: DENSE_VECTOR, limit: PREFETCH_LIMIT },
        {
          query: bm25(query, false),
          using: BM25_VECTOR,
          limit: PREFETCH_LIMIT,
        },
        {
          query: bm25(query, true),
          using: BM25_FOLDED_VECTOR,
          limit: PREFETCH_LIMIT,
        },
      ],
      query: { fusion: 'rrf' },
      limit: CANDIDATES,
      with_payload: true,
    });
    // images on one page all carry that page's text
    const candidates = [
      ...new Map(
        points.map(({ payload }) => {
          const point = parsePayload(KnowledgePointPayload, payload);
          return [point.text, point];
        }),
      ).values(),
    ];

    const ranked = await this.rerank(
      query,
      candidates.map(({ title, text }) => `${title}\n${text}`),
      signal,
    );
    const hits = ranked
      ? ranked
          .filter(({ relevanceScore }) => relevanceScore >= MIN_RELEVANCE)
          .map(({ index }) => candidates[index])
      : candidates.slice(0, RESULTS);
    return hits.map(({ title, page, text }) => ({ title, page, text }));
  }

  private async rerank(
    query: string,
    documents: string[],
    signal?: AbortSignal,
  ): Promise<RerankResult[] | null> {
    try {
      return await this.models.rerank(
        query,
        documents,
        RESULTS,
        AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(RERANK_BUDGET_MS),
        ]),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      this.logger.warn(`Reranking skipped: ${String(error)}`);
      return null;
    }
  }
}
