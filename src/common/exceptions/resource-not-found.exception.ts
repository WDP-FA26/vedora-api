import { AppException } from './app-exception.js';

export const RESOURCE_NOT_FOUND_CODES = [
  'NOT_FOUND',
  'SHARED_POST_UNAVAILABLE',
] as const;

export type ResourceNotFoundCode = (typeof RESOURCE_NOT_FOUND_CODES)[number];

export class ResourceNotFoundException extends AppException<ResourceNotFoundCode> {
  readonly statusCode = 404;
}
