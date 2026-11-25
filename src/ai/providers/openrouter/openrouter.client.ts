import { HTTPClient, OpenRouter } from '@openrouter/sdk';
import { runtimeConfig } from '../../../config/runtime-config.js';
import { aiAppAttribution } from '../provider-shared.js';

/**
 * An OpenRouter SDK client. Pass the cost transport's `fetch` so each call is
 * recorded, or omit it for calls that must not create a cost row. Retries are
 * off: one call is one billed attempt. The SDK sends `httpReferer` and
 * `appTitle` as the `HTTP-Referer` and `X-OpenRouter-Title` headers.
 */
export function createOpenRouterClient(
  apiKey: string,
  fetcher?: typeof fetch,
): OpenRouter {
  const { appUrl, appTitle } = aiAppAttribution();
  return new OpenRouter({
    apiKey,
    httpReferer: appUrl,
    appTitle,
    serverURL: runtimeConfig.OPENROUTER_API_BASE_URL,
    retryConfig: { strategy: 'none' },
    httpClient: fetcher ? new HTTPClient({ fetcher }) : undefined,
  });
}
