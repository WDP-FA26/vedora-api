import { isUniqueViolation } from '../mongo/errors.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';

/**
 * Rethrows a unique-index rejection as a 409 naming the fields that collided,
 * so callers do not see Mongo's error shape.
 */
export function rethrowUniqueViolation(error: unknown): never {
  if (!isUniqueViolation(error)) throw error;
  const keyPattern: unknown = error.keyPattern;
  const fields =
    keyPattern && typeof keyPattern === 'object'
      ? Object.keys(keyPattern).join(', ')
      : '';
  throw new StateConflictException(
    'CONFLICT',
    `${fields || 'Username or email'} already exists`,
  );
}
