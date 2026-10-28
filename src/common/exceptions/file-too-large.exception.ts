import { AppException } from './app-exception.js';

/** An uploaded file is larger than its limit. 413. */
export const FILE_TOO_LARGE_CODES = ['FILE_TOO_LARGE'] as const;

export type FileTooLargeCode = (typeof FILE_TOO_LARGE_CODES)[number];

export class FileTooLargeException extends AppException<FileTooLargeCode> {
  readonly statusCode = 413;
}
