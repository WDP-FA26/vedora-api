import { AppException } from './app-exception.js';

export const UNAUTHENTICATED_CODES = [
  'UNAUTHORIZED',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_NOT_ACTIVE',
  'PAGE_ACCESS_REVOKED',
] as const;

export type UnauthenticatedCode = (typeof UNAUTHENTICATED_CODES)[number];

export class UnauthenticatedException extends AppException<UnauthenticatedCode> {
  readonly statusCode = 401;
}
