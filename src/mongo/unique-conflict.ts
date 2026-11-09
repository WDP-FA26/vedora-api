import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import type { StateConflictCode } from '../common/exceptions/state-conflict.exception.js';
import { isUniqueViolation } from './errors.js';

export function rethrowAsStateConflict(
  error: unknown,
  code: StateConflictCode,
  message: string,
): never {
  if (!isUniqueViolation(error)) throw error;
  throw new StateConflictException(code, message);
}
