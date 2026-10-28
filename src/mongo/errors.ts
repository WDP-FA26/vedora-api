import { MongoServerError } from 'mongodb';

/** MongoDB's duplicate key error: a unique index rejected the write. */
export function isUniqueViolation(error: unknown): error is MongoServerError {
  return error instanceof MongoServerError && error.code === 11000;
}
