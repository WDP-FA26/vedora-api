import { runtimeConfig } from '../../config/runtime-config.js';
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

const PREFETCH_LIMIT = runtimeConfig.KNOWLEDGE_PREFETCH_LIMIT;
const CANDIDATES = runtimeConfig.KNOWLEDGE_CANDIDATE_LIMIT;
const RESULTS = runtimeConfig.KNOWLEDGE_RESULT_LIMIT;
const MIN_RELEVANCE = runtimeConfig.KNOWLEDGE_MIN_RELEVANCE;
const RERANK_BUDGET_MS = runtimeConfig.KNOWLEDGE_RERANK_TIMEOUT_MS;

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
    const dense =
      this.models.sparseOnly === true
        ? null
        : await this.models.embedQuery(query, signal);
    const { points } = await this.qdrant.query(this.index.collection, {
      prefetch: [
        ...(dense
          ? [{ query: dense, using: DENSE_VECTOR, limit: PREFETCH_LIMIT }]
          : []),
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
    const candidates = [
      ...new Map(
        points.map(({ payload }) => {
          const point = parsePayload('qdrant', KnowledgePointPayload, payload);
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
