import { mongo } from 'mongoose';
import { StateConflictException } from '@src/common/exceptions/state-conflict.exception.js';
import { rethrowUniqueViolation } from '@src/users/unique-conflict.js';

function makeMongoError(
  code: number,
  keyPattern?: unknown,
): mongo.MongoServerError {
  const err = new mongo.MongoServerError({ message: `E${code}` });
  err.code = code;
  if (keyPattern !== undefined) {
    err.keyPattern = keyPattern as Record<string, number>;
  }
  return err;
}

describe('rethrowUniqueViolation', () => {
  it('rethrows non-Mongo errors untouched', () => {
    const original = new TypeError('unexpected failure');

    expect(() => rethrowUniqueViolation(original)).toThrow(original);
  });

  it('rethrows MongoServerError when code is not 11000', () => {
    const writeConflict = makeMongoError(112, { _id: 1 });

    expect(() => rethrowUniqueViolation(writeConflict)).toThrow(writeConflict);
  });

  it('throws StateConflictException naming the conflicting keyPattern field', () => {
    const dup = makeMongoError(11000, { email: 1 });

    expect(() => rethrowUniqueViolation(dup)).toThrow(
      new StateConflictException('CONFLICT', 'email already exists'),
    );
  });

  it('joins multiple keyPattern fields with a comma', () => {
    const dup = makeMongoError(11000, { username: 1, email: 1 });

    expect(() => rethrowUniqueViolation(dup)).toThrow(
      new StateConflictException('CONFLICT', 'username, email already exists'),
    );
  });

  it('falls back to "Username or email" when keyPattern is missing or empty', () => {
    const noPattern = makeMongoError(11000);
    const emptyPattern = makeMongoError(11000, {});
    const primitivePattern = makeMongoError(11000, 'email');

    for (const err of [noPattern, emptyPattern, primitivePattern]) {
      expect(() => rethrowUniqueViolation(err)).toThrow(
        new StateConflictException(
          'CONFLICT',
          'Username or email already exists',
        ),
      );
    }
  });
});
