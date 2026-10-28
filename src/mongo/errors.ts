import { mongo } from 'mongoose';

/** MongoDB's duplicate key error: a unique index rejected the write. */
export function isUniqueViolation(
  error: unknown,
): error is mongo.MongoServerError {
  return error instanceof mongo.MongoServerError && error.code === 11000;
}
