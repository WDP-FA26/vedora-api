import { AiModelError } from '@nestjs/ai';
import { APICallError, RetryError } from 'ai';

export type ChatErrorCode = 'RATE_LIMITED' | 'MODEL_ERROR';

function failedCall(error: unknown): APICallError | null {
  const unwrapped = error instanceof AiModelError ? error.cause : error;
  const cause = RetryError.isInstance(unwrapped)
    ? unwrapped.lastError
    : unwrapped;
  return APICallError.isInstance(cause) ? cause : null;
}

export function chatErrorCode(error: unknown): ChatErrorCode {
  return failedCall(error)?.statusCode === 429 ? 'RATE_LIMITED' : 'MODEL_ERROR';
}

export function failedStatus(error: unknown): number | undefined {
  return failedCall(error)?.statusCode;
}
