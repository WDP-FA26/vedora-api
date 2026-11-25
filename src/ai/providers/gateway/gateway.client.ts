import { createGateway } from 'ai';
import { runtimeConfig } from '../../../config/runtime-config.js';
import { aiAppAttribution } from '../provider-shared.js';

export type GatewayClient = ReturnType<typeof createGateway>;

/**
 * The Vercel AI Gateway client with Vedora's base URL and app attribution.
 * Pass `customFetch` to record costs or enforce a per-request timeout.
 */
export function createGatewayClient(
  apiKey: string,
  customFetch?: typeof fetch,
): GatewayClient {
  const { appUrl, appTitle } = aiAppAttribution();
  return createGateway({
    apiKey,
    fetch: customFetch,
    baseURL: runtimeConfig.AI_GATEWAY_API_BASE_URL,
    headers: { 'http-referer': appUrl, 'x-title': appTitle },
  });
}
