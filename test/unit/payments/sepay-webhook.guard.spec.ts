import type { ExecutionContext } from '@nestjs/common';
import { mockDeep } from 'vitest-mock-extended';
import { FeatureUnavailableException } from '../../../src/common/exceptions/feature-unavailable.exception.js';
import { UnauthenticatedException } from '../../../src/common/exceptions/unauthenticated.exception.js';
import { SePayWebhookGuard } from '../../../src/payments/sepay-webhook.guard.js';
import type { SePayProvider } from '../../../src/payments/sepay.provider.js';

function createContext(authorization?: string): ExecutionContext {
  const request = {
    headers: authorization === undefined ? {} : { authorization },
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('SePayWebhookGuard', () => {
  it('passes authorization header to SePayProvider and returns true when valid', () => {
    const provider = mockDeep<SePayProvider>();
    provider.verifyWebhook.mockReturnValue(undefined);
    const guard = new SePayWebhookGuard(provider);

    expect(guard.canActivate(createContext('Apikey secret-key-value'))).toBe(
      true,
    );
    expect(provider.verifyWebhook).toHaveBeenCalledExactlyOnceWith(
      'Apikey secret-key-value',
    );
  });

  it('passes undefined when authorization header is missing', () => {
    const provider = mockDeep<SePayProvider>();
    provider.verifyWebhook.mockImplementation(() => {
      throw new UnauthenticatedException('UNAUTHORIZED', 'Missing key');
    });
    const guard = new SePayWebhookGuard(provider);

    expect(() => guard.canActivate(createContext())).toThrow(
      UnauthenticatedException,
    );
    expect(provider.verifyWebhook).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('propagates FeatureUnavailableException when payments are disabled', () => {
    const provider = mockDeep<SePayProvider>();
    provider.verifyWebhook.mockImplementation(() => {
      throw new FeatureUnavailableException('PAYMENTS_DISABLED', 'Disabled');
    });
    const guard = new SePayWebhookGuard(provider);

    expect(() =>
      guard.canActivate(createContext('Apikey secret-key-value')),
    ).toThrow(FeatureUnavailableException);
  });
});
