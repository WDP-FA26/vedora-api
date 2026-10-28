import { mongo } from 'mongoose';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { rethrowAsStateConflict } from './unique-conflict.js';

function duplicateKeyError(): mongo.MongoServerError {
  return new mongo.MongoServerError({
    message: 'E11000 duplicate key error collection: vedora.favorites',
    code: 11000,
  });
}

function captureError(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('rethrowAsStateConflict', () => {
  it('turns a duplicate key into a 409 with the given business code', () => {
    expect(() =>
      rethrowAsStateConflict(
        duplicateKeyError(),
        'FAVORITE_CONFLICT',
        'The favorite changed; reload and try again',
      ),
    ).toThrow(StateConflictException);

    expect(
      captureError(() =>
        rethrowAsStateConflict(duplicateKeyError(), 'FAVORITE_CONFLICT', 'msg'),
      ),
    ).toMatchObject({
      statusCode: 409,
      code: 'FAVORITE_CONFLICT',
      message: 'msg',
    });
  });

  it('rethrows any other error unchanged', () => {
    const other = new Error('connection reset');

    expect(() =>
      rethrowAsStateConflict(other, 'RATING_CONFLICT', 'msg'),
    ).toThrow(other);
  });
});
