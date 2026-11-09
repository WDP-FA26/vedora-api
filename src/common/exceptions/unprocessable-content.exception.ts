import { AppException } from './app-exception.js';

export const UNPROCESSABLE_CONTENT_CODES = ['CONTENT_REJECTED'] as const;

export type UnprocessableContentCode =
  (typeof UNPROCESSABLE_CONTENT_CODES)[number];

export class UnprocessableContentException extends AppException<UnprocessableContentCode> {
  readonly statusCode = 422;
}
