import { z } from 'zod';

export const DENSE_VECTOR = 'dense';
export const BM25_VECTOR = 'bm25';
export const BM25_FOLDED_VECTOR = 'bm25_folded';

const bm25Options = { stemmer: { type: 'none' }, stopwords: { custom: [] } };

/** Exact and accent-folded BM25 of `text`, computed by Qdrant. */
export function sparseVectors(text: string) {
  return {
    [BM25_VECTOR]: {
      text,
      model: 'qdrant/bm25',
      options: { ...bm25Options, tokenizer: 'word' },
    },
    [BM25_FOLDED_VECTOR]: {
      text,
      model: 'qdrant/bm25',
      options: {
        ...bm25Options,
        tokenizer: 'multilingual',
        ascii_folding: true,
      },
    },
  };
}

export const knowledgePointPayload = z.object({
  documentId: z.string(),
  title: z.string(),
  page: z.number(),
  kind: z.enum(['text', 'image']),
  text: z.string(),
});

export type KnowledgePointPayload = z.infer<typeof knowledgePointPayload>;
