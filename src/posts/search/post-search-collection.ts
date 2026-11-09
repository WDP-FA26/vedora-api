export const DENSE_VECTOR = 'dense';
export const BM25_VECTOR = 'bm25';
export const BM25_FOLDED_VECTOR = 'bm25_folded';

const bm25Base = { stemmer: { type: 'none' }, stopwords: { custom: [] } };

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
  publishedAt: number;
}

export function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
