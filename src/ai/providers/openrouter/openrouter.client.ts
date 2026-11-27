import { HTTPClient, OpenRouter } from '@openrouter/sdk';
import { runtimeConfig } from '../../../config/runtime-config.js';
import { aiAppAttribution } from '../provider-shared.js';

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
