import { AppException } from './app-exception.js';

/** An uploaded file has a type this endpoint does not accept. 415. */
export const UNSUPPORTED_FILE_TYPE_CODES = ['UNSUPPORTED_FILE_TYPE'] as const;

export type UnsupportedFileTypeCode =
  (typeof UNSUPPORTED_FILE_TYPE_CODES)[number];

export class UnsupportedFileTypeException extends AppException<UnsupportedFileTypeCode> {
  readonly statusCode = 415;
}
