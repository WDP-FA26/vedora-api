import { AppException } from './app-exception.js';

/** A quota, rate limit or attempt limit was reached. Retry later. 429. */
export const QUOTA_REACHED_CODES = [
  'TOO_MANY_REQUESTS',
  'AI_QUOTA_EXCEEDED',
  'GUEST_QUOTA_REACHED',
  'UPLOAD_LIMIT_REACHED',
  'PROOF_LIMIT_REACHED',
  'VERIFY_LIMIT_REACHED',
  'RESEND_LIMIT_REACHED',
] as const;

export type QuotaReachedCode = (typeof QUOTA_REACHED_CODES)[number];

export class QuotaReachedException extends AppException<QuotaReachedCode> {
  readonly statusCode = 429;
}
