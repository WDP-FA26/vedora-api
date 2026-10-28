import { ConflictException } from '@nestjs/common';
import { isUniqueViolation } from '../mongo/errors.js';

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
  throw new ConflictException(
    `${fields || 'Username or email'} already exists`,
  );
}
