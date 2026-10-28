import type { ApiResponseOptions } from '@nestjs/swagger';
import { ErrorBodyDto } from './error-body.dto.js';

const ERROR_RESPONSES: { status: number; description: string }[] = [
  { status: 400, description: 'Invalid request or a business rule was broken' },
  { status: 401, description: 'Not signed in, or the account cannot act' },
  { status: 403, description: 'Signed in but not allowed' },
  { status: 404, description: 'The resource does not exist or is not visible' },
  { status: 409, description: 'The request conflicts with the current state' },
  { status: 429, description: 'A quota or attempt limit was reached' },
  { status: 500, description: 'Unexpected server error' },
  { status: 502, description: 'A third-party service failed' },
  { status: 503, description: 'The feature is unavailable' },
];

/** Every operation documents the shared error body for each error status. */
export function errorResponses(): ApiResponseOptions[] {
  return ERROR_RESPONSES.map(({ status, description }) => ({
    status,
    description,
    type: ErrorBodyDto,
  }));
}
