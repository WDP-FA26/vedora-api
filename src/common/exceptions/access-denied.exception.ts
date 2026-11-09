import { AppException } from './app-exception.js';

export const ACCESS_DENIED_CODES = [
  'FORBIDDEN',
  'EMAIL_NOT_VERIFIED',
  'CAPTCHA_FAILED',
  'SELF_RATING_NOT_ALLOWED',
  'MESSAGE_FOLLOW_REQUIRED',
] as const;

export type AccessDeniedCode = (typeof ACCESS_DENIED_CODES)[number];

export class AccessDeniedException extends AppException<AccessDeniedCode> {
  readonly statusCode = 403;
}
