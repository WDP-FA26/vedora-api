import type { ConfigService } from '@nestjs/config';
import type {
  AiModelFactory,
  AiProviderAdapter,
  AiProviderId,
  ProviderDialect,
  ProviderModelKind,
} from './ai-provider.interface.js';
import {
  DEFAULT_GATEWAY_PROVIDER_ORDER,
  gatewayAdapter,
} from './gateway/gateway.adapter.js';
import {
  createGatewayClient,
  type GatewayClient,
} from './gateway/gateway.client.js';
import {
  DEFAULT_OPENROUTER_CHAT_PROVIDER_ORDER,
  DEFAULT_OPENROUTER_MODERATION_PROVIDER_ORDER,
  openRouterAdapter,
} from './openrouter/openrouter.adapter.js';

export {
  DEFAULT_GATEWAY_PROVIDER_ORDER,
  DEFAULT_OPENROUTER_CHAT_PROVIDER_ORDER,
  DEFAULT_OPENROUTER_MODERATION_PROVIDER_ORDER,
};

const PROVIDERS: Record<AiProviderId, AiProviderAdapter> = {
  gateway: gatewayAdapter,
  openrouter: openRouterAdapter,
};

export const ALL_PROVIDER_ADAPTERS: readonly AiProviderAdapter[] =
  Object.values(PROVIDERS);

export function activeProvider(): AiProviderId {
  return process.env.AI_PROVIDER === 'openrouter' ? 'openrouter' : 'gateway';
}

export function providerAdapter(
  id: AiProviderId = activeProvider(),
): AiProviderAdapter {
  return PROVIDERS[id];
}

export function providerDialect(): ProviderDialect {
  return providerAdapter().dialect;
}

export function aiModels(config: ConfigService): AiModelFactory {
  return providerAdapter().createModels(config);
}

export function modelIdFor(
  config: ConfigService,
  kind: ProviderModelKind,
): string {
  return providerAdapter().modelIdFor(config, kind);
}

export function chatProviderOrder(config: ConfigService): string[] {
  return providerAdapter().chatProviderOrder(config);
}

export function moderationProviderOrder(config: ConfigService): string[] {
  return providerAdapter().moderationProviderOrder(config);
}

export function createGatewayRealtimeClient(apiKey: string): GatewayClient {
  return createGatewayClient(apiKey);
}
