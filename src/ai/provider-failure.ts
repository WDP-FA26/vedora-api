import { ExternalServiceException } from '../common/exceptions/external-service.exception.js';
import type { AiServiceName } from './providers/ai-provider.interface.js';
import { providerAdapter } from './providers/provider-registry.js';

/** The external service name of the provider in use, as API errors report it. */
export function aiService(): AiServiceName {
  return providerAdapter().serviceName;
}

function statusCodeOf(error: unknown): number | undefined {
  if (!(error instanceof Error) || !('statusCode' in error)) return undefined;
  return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

/**
 * Turns any AI SDK failure into the exception the API reports for the
 * provider in use, with the HTTP status when the error carries one (AI SDK,
 * Gateway and OpenRouter SDK errors all do).
 */
export function aiFailure(
  operation: string,
  error: unknown,
): ExternalServiceException {
  if (error instanceof ExternalServiceException) return error;
  const message = error instanceof Error ? error.message : String(error);
  const status = statusCodeOf(error);
  const failed = status === undefined ? 'failed' : `failed (${status})`;
  return new ExternalServiceException(
    aiService(),
    `${operation} ${failed}: ${message}`,
    { cause: error },
  );
}
