import { AppException } from './app-exception.js';

/** The caller is signed in but not allowed to do this. 403. */
export const ACCESS_DENIED_CODES = [
  'FORBIDDEN',
  'EMAIL_NOT_VERIFIED',
  'CAPTCHA_FAILED',
  'SELF_RATING_NOT_ALLOWED',
] as const;

export type AccessDeniedCode = (typeof ACCESS_DENIED_CODES)[number];

export class AccessDeniedException extends AppException<AccessDeniedCode> {
  readonly statusCode = 403;
}
