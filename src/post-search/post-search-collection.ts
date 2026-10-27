/** Named vectors of the post search collection. */
export const DENSE_VECTOR = 'dense';
export const BM25_VECTOR = 'bm25';
/** Matches Vietnamese typed without accents ("dau hu" finds "đậu hũ"). */
export const BM25_FOLDED_VECTOR = 'bm25_folded';

const bm25Base = { stemmer: { type: 'none' }, stopwords: { custom: [] } };

/** Qdrant computes BM25 server side from the raw text. */
export function bm25(text: string, folded: boolean) {
  return {
    text,
    model: 'qdrant/bm25',
    options: folded
      ? { ...bm25Base, tokenizer: 'multilingual', ascii_folding: true }
      : { ...bm25Base, tokenizer: 'word' },
  };
}

export interface PostPointPayload {
  postId: string;
  authorId: string;
  /** Unix seconds; the feed filters and decays on it. */
  publishedAt: number;
}

export function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
