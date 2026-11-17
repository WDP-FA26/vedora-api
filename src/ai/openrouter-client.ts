import { HTTPClient, OpenRouter } from '@openrouter/sdk';
import { OpenRouterError } from '@openrouter/sdk/models/errors';
import { ExternalServiceException } from '../common/exceptions/external-service.exception.js';

/**
 * An OpenRouter SDK client. Pass the cost transport's `fetch` so each call is
 * recorded, or omit it for calls that must not create a cost row. Retries are
 * off: one call is one billed attempt.
 */
export function createOpenRouterClient(
  apiKey: string,
  fetcher?: typeof fetch,
): OpenRouter {
  return new OpenRouter({
    apiKey,
    retryConfig: { strategy: 'none' },
    httpClient: fetcher ? new HTTPClient({ fetcher }) : undefined,
  });
}

/** Turns any SDK failure into the exception the API reports for OpenRouter. */
export function openRouterFailure(
  operation: string,
  error: unknown,
): ExternalServiceException {
  if (error instanceof ExternalServiceException) return error;
  if (error instanceof OpenRouterError) {
    return new ExternalServiceException(
      'openrouter',
      `${operation} failed (${error.statusCode}): ${error.message}`,
      { cause: error },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ExternalServiceException(
    'openrouter',
    `${operation} failed: ${message}`,
    { cause: error },
  );
}
