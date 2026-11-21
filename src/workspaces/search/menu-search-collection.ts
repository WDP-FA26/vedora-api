export const MENU_DENSE_VECTOR = 'dense';
export const MENU_BM25_VECTOR = 'bm25';
export const MENU_BM25_FOLDED_VECTOR = 'bm25_folded';

const bm25Base = {
  stemmer: { type: 'none' },
  stopwords: { custom: [] },
  avg_len: 24,
} as const;

export function menuBm25(text: string, folded: boolean) {
  return {
    text,
    model: 'qdrant/bm25',
    options: folded
      ? { ...bm25Base, tokenizer: 'multilingual', ascii_folding: true }
      : { ...bm25Base, tokenizer: 'word' },
  };
}

export interface MenuItemPointPayload {
  itemId: string;
  workspaceId: string;
  pageUserId: string;
}

export function buildMenuItemSearchText(
  item: {
    name: string;
    category: string | null;
    description: string | null;
  },
  restaurant: {
    name: string;
    address: string;
  },
): string {
  return [
    item.name,
    item.category,
    item.description,
    restaurant.name,
    restaurant.address,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => part.trim())
    .join('\n');
}
