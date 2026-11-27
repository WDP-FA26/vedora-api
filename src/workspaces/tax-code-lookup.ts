/**
 * Pure helpers for looking up a page application's tax code with the tax
 * department's public data (served by VietQR): which codes can be looked up,
 * the response shape, and whether the official name matches the one typed.
 */
import { z } from 'zod';

/** Company codes: 10 digits, or 10-3 for a branch. Personal 12-digit codes are not public. */
const PUBLIC_TAX_CODE = /^\d{10}(-\d{3})?$/;

export function isPublicTaxCode(taxCode: string): boolean {
  return PUBLIC_TAX_CODE.test(taxCode);
}

/** VietQR `GET /v2/business/:taxCode`: code "00" found, "51" unknown code. */
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

/** Words naming the legal form, which people write in many ways or leave out. */
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

/** Lowercase words without accents, without the legal-form words. */
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

/**
 * Whether the name typed in the application is the official one, ignoring
 * accents, case, punctuation and how the legal form is written: every
 * distinctive word of one appears in the other.
 */
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
