import { AppException } from './app-exception.js';

/** The caller is not signed in, or the account cannot act. 401. */
export const UNAUTHENTICATED_CODES = [
  'UNAUTHORIZED',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_NOT_ACTIVE',
] as const;

export type UnauthenticatedCode = (typeof UNAUTHENTICATED_CODES)[number];

export class UnauthenticatedException extends AppException<UnauthenticatedCode> {
  readonly statusCode = 401;
}
