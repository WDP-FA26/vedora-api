import { AppException } from './app-exception.js';

/** The request is malformed or breaks a rule that does not depend on the stored state. 400. */
export const INVALID_INPUT_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'EMPTY_POST',
  'OWN_POST',
  'MEDIA_UNAVAILABLE',
  'INVALID_DASHBOARD_RANGE',
  'BLOG_AI_INVALID_MESSAGES',
  'BLOG_CONTENT_REQUIRED',
  'BLOG_COVER_NOT_ALLOWED',
  'BLOG_RECIPE_NOT_FOUND',
  'UNKNOWN_REFERENCE',
  'CONFLICTING_PREFERENCE',
  'SAME_INGREDIENT',
] as const;

export type InvalidInputCode = (typeof INVALID_INPUT_CODES)[number];

export class InvalidInputException extends AppException<InvalidInputCode> {
  readonly statusCode = 400;
}
