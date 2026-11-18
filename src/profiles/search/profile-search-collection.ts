export const IDENTITY_BM25_VECTOR = 'identity_bm25';
export const IDENTITY_BM25_FOLDED_VECTOR = 'identity_bm25_folded';
export const IDENTITY_PREFIX_VECTOR = 'identity_prefix';
export const BIO_BM25_VECTOR = 'bio_bm25';
export const BIO_BM25_FOLDED_VECTOR = 'bio_bm25_folded';

export const PROFILE_SEARCH_SPARSE_VECTORS = [
  IDENTITY_BM25_VECTOR,
  IDENTITY_BM25_FOLDED_VECTOR,
  IDENTITY_PREFIX_VECTOR,
  BIO_BM25_VECTOR,
  BIO_BM25_FOLDED_VECTOR,
] as const;

const bm25Base = {
  stemmer: { type: 'none' },
  stopwords: { custom: [] },
  avg_len: 16,
} as const;

/** BM25 document descriptor for profile fields (exact or diacritic-folded). */
export function profileBm25(text: string, folded: boolean) {
  return {
    text,
    model: 'qdrant/bm25',
    options: folded
      ? { ...bm25Base, tokenizer: 'multilingual', ascii_folding: true }
      : { ...bm25Base, tokenizer: 'word' },
  };
}

/** BM25 prefix-tokenized descriptor used when indexing names and handles. */
export function profilePrefixBm25(text: string) {
  return {
    text,
    model: 'qdrant/bm25',
    options: {
      ...bm25Base,
      tokenizer: 'prefix',
      ascii_folding: true,
      min_token_len: 2,
    },
  };
}

/** Strips leading `@` handle prefixes while keeping multi-word queries intact. */
export function normalizeProfileQuery(query: string): string {
  return query
    .trim()
    .replace(/(^|\s)@+/g, '$1')
    .trim();
}

/** Combines full name and username (including separator-split tokens) for BM25 indexing. */
export function buildProfileIdentityText(user: {
  fullName: string;
  username: string;
}): string {
  const splitUsername = user.username.replace(/[._-]+/g, ' ');
  return splitUsername === user.username
    ? `${user.fullName}\n${user.username}`
    : `${user.fullName}\n${user.username}\n${splitUsername}`;
}
