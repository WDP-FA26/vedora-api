import { AppException } from './app-exception.js';

/** The requested resource does not exist, or is not visible to the caller. 404. */
export const RESOURCE_NOT_FOUND_CODES = ['NOT_FOUND'] as const;

export type ResourceNotFoundCode = (typeof RESOURCE_NOT_FOUND_CODES)[number];

export class ResourceNotFoundException extends AppException<ResourceNotFoundCode> {
  readonly statusCode = 404;
}
