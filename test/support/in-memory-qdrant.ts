type PointId = string | number;

interface Bm25Document {
  text: string;
  model?: string;
  options?: {
    ascii_folding?: boolean;
    tokenizer?: string;
  };
}

type VectorValue = number[] | Bm25Document;
type NamedVectors = Record<string, VectorValue>;

interface StoredPoint {
  id: PointId;
  vector: VectorValue | NamedVectors;
  payload: Record<string, unknown>;
}

interface StoredCollection {
  config: {
    params: {
      vectors?: unknown;
      sparse_vectors?: unknown;
    };
  };
  points: Map<string, StoredPoint>;
}

interface FilterCondition {
  key?: string;
  match?: { value?: unknown; any?: unknown[] };
  range?: { gte?: number; lte?: number; gt?: number; lt?: number };
  has_id?: PointId[];
}

interface QdrantFilter {
  must?: FilterCondition[];
  must_not?: FilterCondition[];
  should?: FilterCondition[];
}

interface PrefetchQuery {
  query: unknown;
  using?: string;
  filter?: QdrantFilter;
  limit?: number;
  score_threshold?: number;
}

interface QueryParams {
  prefetch?: PrefetchQuery | PrefetchQuery[];
  query?: unknown;
  using?: string;
  filter?: QdrantFilter;
  offset?: number;
  limit?: number;
  score_threshold?: number;
  with_payload?: boolean | string[];
  with_vector?: boolean | string[];
}

interface ScoredPoint {
  id: PointId;
  score: number;
  payload?: Record<string, unknown>;
  vector?: VectorValue | NamedVectors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    (value.length === 0 || typeof value[0] === 'number')
  );
}

function isBm25Document(value: unknown): value is Bm25Document {
  return isRecord(value) && typeof value.text === 'string';
}

function tokenize(text: string, fold: boolean): string[] {
  let normalized = text.toLowerCase();
  if (fold) {
    normalized = normalized
      .replaceAll('đ', 'd')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }
  return normalized
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function bm25Score(
  query: Bm25Document,
  doc: Bm25Document,
  foldOverride?: boolean,
): number {
  const fold = foldOverride ?? Boolean(query.options?.ascii_folding);
  const queryTokens = tokenize(query.text, fold);
  if (queryTokens.length === 0) return 0;
  const docTokens = tokenize(doc.text, fold);
  if (docTokens.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const token of docTokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  let score = 0;
  for (const qToken of queryTokens) {
    const tf = freq.get(qToken) ?? 0;
    if (tf > 0) {
      score += tf / (tf + 1.2);
    } else if (docTokens.some((dToken) => dToken.startsWith(qToken))) {
      score += 0.4;
    }
  }
  return score;
}

function matchesCondition(
  point: StoredPoint,
  condition: FilterCondition,
): boolean {
  if (condition.has_id) {
    const idSet = new Set(condition.has_id.map(String));
    return idSet.has(String(point.id));
  }
  if (!condition.key) return true;
  const value = point.payload[condition.key];

  if (condition.match) {
    if (condition.match.any !== undefined) {
      if (Array.isArray(value)) {
        return value.some((v) => condition.match?.any?.includes(v));
      }
      return condition.match.any.includes(value);
    }
    if (Array.isArray(value)) {
      return value.includes(condition.match.value);
    }
    return value === condition.match.value;
  }

  if (condition.range) {
    if (typeof value !== 'number') return false;
    const { gte, lte, gt, lt } = condition.range;
    if (gte !== undefined && value < gte) return false;
    if (lte !== undefined && value > lte) return false;
    if (gt !== undefined && value <= gt) return false;
    if (lt !== undefined && value >= lt) return false;
    return true;
  }

  return true;
}

function matchesFilter(point: StoredPoint, filter?: QdrantFilter): boolean {
  if (!filter) return true;
  if (filter.must) {
    for (const cond of filter.must) {
      if (!matchesCondition(point, cond)) return false;
    }
  }
  if (filter.must_not) {
    for (const cond of filter.must_not) {
      if (matchesCondition(point, cond)) return false;
    }
  }
  if (filter.should && filter.should.length > 0) {
    const matched = filter.should.some((cond) => matchesCondition(point, cond));
    if (!matched) return false;
  }
  return true;
}

function extractVector(
  point: StoredPoint,
  using?: string,
): VectorValue | undefined {
  if (!using) {
    if (isNumberArray(point.vector) || isBm25Document(point.vector)) {
      return point.vector;
    }
    return undefined;
  }
  if (isRecord(point.vector) && !isBm25Document(point.vector)) {
    return point.vector[using];
  }
  return undefined;
}

function scoreSingleQuery(
  point: StoredPoint,
  query: unknown,
  using?: string,
): number | null {
  const stored = extractVector(point, using);
  if (!stored) return null;

  if (isNumberArray(query) && isNumberArray(stored)) {
    return cosineSimilarity(query, stored);
  }
  if (isBm25Document(query) && isBm25Document(stored)) {
    const score = bm25Score(query, stored);
    return score > 0 ? score : null;
  }
  if (isRecord(query) && isRecord(query.recommend) && isNumberArray(stored)) {
    const positive = query.recommend.positive;
    if (!Array.isArray(positive) || positive.length === 0) return null;
    let best = -Infinity;
    for (const vec of positive) {
      if (isNumberArray(vec)) {
        const sim = cosineSimilarity(vec, stored);
        if (sim > best) best = sim;
      }
    }
    return Number.isFinite(best) ? best : null;
  }
  return null;
}

function evaluateFormula(
  formula: unknown,
  point: StoredPoint,
  baseScore: number,
): number {
  if (formula === '$score') return baseScore;
  if (typeof formula === 'number') return formula;
  if (!isRecord(formula)) return baseScore;

  if (Array.isArray(formula.sum)) {
    let total = 0;
    for (const term of formula.sum) {
      total += evaluateFormula(term, point, baseScore);
    }
    return total;
  }
  if (Array.isArray(formula.mult)) {
    let product = 1;
    for (const factor of formula.mult) {
      product *= evaluateFormula(factor, point, baseScore);
    }
    return product;
  }
  if (isRecord(formula.exp_decay)) {
    const field = formula.exp_decay.x;
    const target = formula.exp_decay.target;
    const scale = formula.exp_decay.scale;
    const raw = typeof field === 'string' ? point.payload[field] : undefined;
    if (
      typeof raw === 'number' &&
      typeof target === 'number' &&
      typeof scale === 'number' &&
      scale > 0
    ) {
      return Math.exp((-Math.abs(target - raw) * Math.LN2) / scale);
    }
    return 0;
  }
  return baseScore;
}

/**
 * Zero-container, in-memory drop-in for `QdrantService` in e2e tests.
 * Supports dense cosine similarity, BM25 text scoring, RRF fusion, recommend,
 * formula rescoring, and payload filters without requiring a Qdrant container.
 */
export class InMemoryQdrantService {
  private readonly collections = new Map<string, StoredCollection>();

  onModuleInit(): Promise<void> {
    return Promise.resolve();
  }

  getCollections(): Promise<{ collections: Array<{ name: string }> }> {
    const collections = [...this.collections.keys()].map((name) => ({ name }));
    return Promise.resolve({ collections });
  }

  collectionExists(name: string): Promise<{ exists: boolean }> {
    return Promise.resolve({ exists: this.collections.has(name) });
  }

  getCollection(name: string): Promise<{
    config: { params: { vectors?: unknown; sparse_vectors?: unknown } };
  }> {
    const col = this.collections.get(name);
    if (!col) {
      return Promise.reject(new Error(`Collection ${name} does not exist`));
    }
    return Promise.resolve({ config: col.config });
  }

  createCollection(
    name: string,
    config: { vectors?: unknown; sparse_vectors?: unknown },
  ): Promise<boolean> {
    this.collections.set(name, {
      config: {
        params: {
          vectors: config.vectors,
          sparse_vectors: config.sparse_vectors,
        },
      },
      points: new Map(),
    });
    return Promise.resolve(true);
  }

  deleteCollection(name: string): Promise<boolean> {
    return Promise.resolve(this.collections.delete(name));
  }

  createPayloadIndex(_name: string, _params: unknown): Promise<{ status: string }> {
    return Promise.resolve({ status: 'completed' });
  }

  upsert(
    name: string,
    params: {
      points: Array<{
        id: PointId;
        vector: VectorValue | NamedVectors;
        payload?: Record<string, unknown>;
      }>;
    },
  ): Promise<{ status: string }> {
    const col = this.requireCollection(name);
    for (const point of params.points) {
      col.points.set(String(point.id), {
        id: point.id,
        vector: point.vector,
        payload: point.payload ? { ...point.payload } : {},
      });
    }
    return Promise.resolve({ status: 'completed' });
  }

  delete(
    name: string,
    params: { points?: PointId[]; filter?: QdrantFilter },
  ): Promise<{ status: string }> {
    const col = this.collections.get(name);
    if (!col) return Promise.resolve({ status: 'completed' });

    if (params.points) {
      for (const id of params.points) {
        col.points.delete(String(id));
      }
    }
    if (params.filter) {
      for (const [key, point] of col.points.entries()) {
        if (matchesFilter(point, params.filter)) {
          col.points.delete(key);
        }
      }
    }
    return Promise.resolve({ status: 'completed' });
  }

  retrieve(
    name: string,
    params: {
      ids: PointId[];
      with_payload?: boolean | string[];
      with_vector?: boolean | string[];
    },
  ): Promise<
    Array<{
      id: PointId;
      payload?: Record<string, unknown>;
      vector?: VectorValue | NamedVectors;
    }>
  > {
    const col = this.collections.get(name);
    if (!col) return Promise.resolve([]);
    const results: Array<{
      id: PointId;
      payload?: Record<string, unknown>;
      vector?: VectorValue | NamedVectors;
    }> = [];
    for (const id of params.ids) {
      const point = col.points.get(String(id));
      if (!point) continue;
      results.push({
        id: point.id,
        payload: params.with_payload ? { ...point.payload } : undefined,
        vector: this.pickVector(point, params.with_vector),
      });
    }
    return Promise.resolve(results);
  }

  count(
    name: string,
    params?: { filter?: QdrantFilter; exact?: boolean },
  ): Promise<{ count: number }> {
    const col = this.collections.get(name);
    if (!col) return Promise.resolve({ count: 0 });
    let count = 0;
    for (const point of col.points.values()) {
      if (matchesFilter(point, params?.filter)) count += 1;
    }
    return Promise.resolve({ count });
  }

  query(name: string, params: QueryParams): Promise<{ points: ScoredPoint[] }> {
    const col = this.collections.get(name);
    if (!col) return Promise.resolve({ points: [] });

    const prefetches = params.prefetch
      ? Array.isArray(params.prefetch)
        ? params.prefetch
        : [params.prefetch]
      : [];

    let ranked: Array<{ point: StoredPoint; score: number }>;

    if (prefetches.length > 0) {
      const lists = prefetches.map((pf) => this.runPrefetch(col, pf));
      if (isRecord(params.query) && isRecord(params.query.formula)) {
        const formula = params.query.formula;
        ranked = lists[0]
          .map(({ point, score }) => ({
            point,
            score: evaluateFormula(formula, point, score),
          }))
          .sort((a, b) => b.score - a.score);
      } else {
        const weights = this.rrfWeights(params.query, lists.length);
        ranked = this.fuseRrf(lists, weights);
      }
    } else {
      ranked = this.runPrefetch(col, {
        query: params.query,
        using: params.using,
        filter: params.filter,
        score_threshold: params.score_threshold,
      });
    }

    if (params.filter && prefetches.length > 0) {
      ranked = ranked.filter(({ point }) => matchesFilter(point, params.filter));
    }

    const offset = params.offset ?? 0;
    const limit = params.limit ?? 10;
    const sliced = ranked.slice(offset, offset + limit);

    const points: ScoredPoint[] = sliced.map(({ point, score }) => ({
      id: point.id,
      score,
      payload: params.with_payload ? { ...point.payload } : undefined,
      vector: this.pickVector(point, params.with_vector),
    }));

    return Promise.resolve({ points });
  }

  private runPrefetch(
    col: StoredCollection,
    pf: PrefetchQuery,
  ): Array<{ point: StoredPoint; score: number }> {
    const scored: Array<{ point: StoredPoint; score: number }> = [];
    for (const point of col.points.values()) {
      if (!matchesFilter(point, pf.filter)) continue;
      const score = scoreSingleQuery(point, pf.query, pf.using);
      if (score === null) continue;
      if (pf.score_threshold !== undefined && score < pf.score_threshold) {
        continue;
      }
      scored.push({ point, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return pf.limit !== undefined ? scored.slice(0, pf.limit) : scored;
  }

  private rrfWeights(query: unknown, count: number): number[] {
    if (isRecord(query) && isRecord(query.rrf) && Array.isArray(query.rrf.weights)) {
      return query.rrf.weights.map((w) => (typeof w === 'number' ? w : 1));
    }
    return Array.from({ length: count }, () => 1);
  }

  private fuseRrf(
    lists: Array<Array<{ point: StoredPoint; score: number }>>,
    weights: number[],
  ): Array<{ point: StoredPoint; score: number }> {
    const scores = new Map<string, { point: StoredPoint; score: number }>();
    for (let i = 0; i < lists.length; i += 1) {
      const weight = weights[i] ?? 1;
      const list = lists[i];
      for (let rank = 0; rank < list.length; rank += 1) {
        const { point } = list[rank];
        const key = String(point.id);
        const contrib = weight / (60 + rank + 1);
        const existing = scores.get(key);
        if (existing) {
          existing.score += contrib;
        } else {
          scores.set(key, { point, score: contrib });
        }
      }
    }
    return [...scores.values()].sort((a, b) => b.score - a.score);
  }

  private pickVector(
    point: StoredPoint,
    withVector?: boolean | string[],
  ): VectorValue | NamedVectors | undefined {
    if (!withVector) return undefined;
    if (withVector === true) return point.vector;
    if (Array.isArray(withVector) && isRecord(point.vector) && !isBm25Document(point.vector)) {
      const picked: NamedVectors = {};
      for (const key of withVector) {
        if (key in point.vector) {
          picked[key] = point.vector[key];
        }
      }
      return picked;
    }
    return point.vector;
  }

  private requireCollection(name: string): StoredCollection {
    const col = this.collections.get(name);
    if (!col) {
      throw new Error(`Collection ${name} does not exist`);
    }
    return col;
  }
}
