import { mongo } from 'mongoose';

export function isUniqueViolation(
  error: unknown,
): error is mongo.MongoServerError {
  return error instanceof mongo.MongoServerError && error.code === 11000;
}
