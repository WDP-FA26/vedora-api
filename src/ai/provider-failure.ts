import { ExternalServiceException } from '../common/exceptions/external-service.exception.js';
import type { AiServiceName } from './providers/ai-provider.interface.js';
import { providerAdapter } from './providers/provider-registry.js';

export function aiService(): AiServiceName {
  return providerAdapter().serviceName;
}

function statusCodeOf(error: unknown): number | undefined {
  if (!(error instanceof Error) || !('statusCode' in error)) return undefined;
  return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

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
