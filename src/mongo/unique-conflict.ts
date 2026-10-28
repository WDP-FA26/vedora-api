import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import type { StateConflictCode } from '../common/exceptions/state-conflict.exception.js';
import { isUniqueViolation } from './errors.js';

/**
 * Turns a unique-index rejection into a 409 with a business code, so a rare
 * concurrent write reports a conflict instead of a 500. Any other error
 * passes through unchanged.
 */
export function rethrowAsStateConflict(
  error: unknown,
  code: StateConflictCode,
  message: string,
): never {
  if (!isUniqueViolation(error)) throw error;
  throw new StateConflictException(code, message);
}
