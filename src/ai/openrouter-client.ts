import { HTTPClient, OpenRouter } from '@openrouter/sdk';
import { runtimeConfig } from '../config/runtime-config.js';
import { OpenRouterError } from '@openrouter/sdk/models/errors';
import { ExternalServiceException } from '../common/exceptions/external-service.exception.js';
import {
  openRouterAttribution,
  openRouterAttributionHeaders,
} from './openrouter-attribution.js';

/**
 * An OpenRouter SDK client. Pass the cost transport's `fetch` so each call is
 * recorded, or omit it for calls that must not create a cost row. Retries are
 * off: one call is one billed attempt.
 */
export function createOpenRouterClient(
  apiKey: string,
  fetcher?: typeof fetch,
): OpenRouter {
  const { appUrl, appTitle } = openRouterAttribution();
  const headers = openRouterAttributionHeaders({ appUrl, appTitle });
  const httpClient = new HTTPClient(fetcher ? { fetcher } : undefined);
  httpClient.addHook('beforeRequest', (req) => {
    for (const [name, value] of Object.entries(headers)) {
      if (!req.headers.has(name)) {
        req.headers.set(name, value);
      }
    }
  });
  return new OpenRouter({
    apiKey,
    httpReferer: appUrl,
    appTitle,
    serverURL: runtimeConfig.OPENROUTER_API_BASE_URL,
    retryConfig: { strategy: 'none' },
    httpClient,
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
