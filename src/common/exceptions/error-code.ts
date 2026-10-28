import { ACCESS_DENIED_CODES } from './access-denied.exception.js';
import { FEATURE_UNAVAILABLE_CODES } from './feature-unavailable.exception.js';
import { FILE_TOO_LARGE_CODES } from './file-too-large.exception.js';
import { INVALID_INPUT_CODES } from './invalid-input.exception.js';
import { QUOTA_REACHED_CODES } from './quota-reached.exception.js';
import { RESOURCE_NOT_FOUND_CODES } from './resource-not-found.exception.js';
import { STATE_CONFLICT_CODES } from './state-conflict.exception.js';
import { UNAUTHENTICATED_CODES } from './unauthenticated.exception.js';
import { UNSUPPORTED_FILE_TYPE_CODES } from './unsupported-file-type.exception.js';

/**
 * Every code the API can return. Served to clients as the `code` enum in the
 * Swagger document, so it must list each code the filter or a family can emit.
 */
export const ERROR_CODES = [
  ...ACCESS_DENIED_CODES,
  ...FEATURE_UNAVAILABLE_CODES,
  ...FILE_TOO_LARGE_CODES,
  ...INVALID_INPUT_CODES,
  ...QUOTA_REACHED_CODES,
  ...RESOURCE_NOT_FOUND_CODES,
  ...STATE_CONFLICT_CODES,
  ...UNAUTHENTICATED_CODES,
  ...UNSUPPORTED_FILE_TYPE_CODES,
  'EXTERNAL_SERVICE_FAILED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
