import { z } from 'zod';

const PUBLIC_TAX_CODE = /^\d{10}(-\d{3})?$/;

export function isPublicTaxCode(taxCode: string): boolean {
  return PUBLIC_TAX_CODE.test(taxCode);
}

export const vietQrBusinessSchema = z.object({
  code: z.string(),
  data: z
    .object({
      id: z.string(),
      name: z.string(),
      shortName: z.string().nullish(),
      address: z.string().nullish(),
      status: z.string().nullish(),
    })
    .nullish(),
  metadata: z.object({ updatedAt: z.string().nullish() }).nullish(),
});

export const VIETQR_FOUND = '00';
export const VIETQR_NOT_FOUND = '51';

const LEGAL_FORM_WORDS = new Set([
  'cong',
  'ty',
  'tnhh',
  'mtv',
  'co',
  'phan',
  'cp',
  'jsc',
  'ltd',
  'trach',
  'nhiem',
  'huu',
  'han',
  'mot',
  'thanh',
  'vien',
  'ho',
  'kinh',
  'doanh',
  'hkd',
  'chi',
  'nhanh',
  'tap',
  'doan',
  'dntn',
  'nghiep',
  'tu',
  'nhan',
]);

function nameWords(name: string): string[] {
  const folded = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
  const words: string[] = [];
  for (const word of folded.split(/[^a-z0-9]+/)) {
    if (word !== '' && !LEGAL_FORM_WORDS.has(word)) words.push(word);
  }
  return words;
}

export function legalNameMatches(official: string, typed: string): boolean {
  const officialWords = nameWords(official);
  const typedWords = nameWords(typed);
  if (officialWords.length === 0 || typedWords.length === 0) return false;
  const officialSet = new Set(officialWords);
  const typedSet = new Set(typedWords);
  const typedInOfficial = typedWords.every((word) => officialSet.has(word));
  const officialInTyped = officialWords.every((word) => typedSet.has(word));
  return typedInOfficial || officialInTyped;
}
