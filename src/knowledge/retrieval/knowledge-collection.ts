import { IsIn, IsNumber, IsString } from 'class-validator';

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

/** The payload stored with every Qdrant point of the knowledge base. */
export class KnowledgePointPayload {
  /** Qdrant treats a payload as an open map. */
  [key: string]: unknown;

  @IsString()
  documentId!: string;

  @IsString()
  title!: string;

  @IsNumber()
  page!: number;

  @IsIn(['text', 'image'])
  kind!: 'text' | 'image';

  @IsString()
  text!: string;
}
