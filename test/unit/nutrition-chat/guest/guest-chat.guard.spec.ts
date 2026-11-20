import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { FeatureUnavailableException } from '../../../../src/common/exceptions/feature-unavailable.exception.js';
import { QuotaReachedException } from '../../../../src/common/exceptions/quota-reached.exception.js';
import { UnauthenticatedException } from '../../../../src/common/exceptions/unauthenticated.exception.js';
import type { ClientIpService } from '../../../../src/nutrition-chat/guest/client-ip.service.js';
import { GuestChatGuard } from '../../../../src/nutrition-chat/guest/guest-chat.guard.js';
import type { GuestQuotaService } from '../../../../src/nutrition-chat/guest/guest-quota.service.js';
import type { GuestSessionService } from '../../../../src/nutrition-chat/guest/guest-session.service.js';

function contextWithAuth(
  authorization?: string,
  body?: unknown,
): ExecutionContext {
  const request = { headers: { authorization }, body } as unknown as Request;
  return {
    switchToHttp: () => ({
      getRequest: <T>() => request as unknown as T,
    }),
  } as unknown as ExecutionContext;
}

describe('GuestChatGuard', () => {
  let sessions: DeepMockProxy<GuestSessionService>;
  let quota: DeepMockProxy<GuestQuotaService>;
  let clientIp: DeepMockProxy<ClientIpService>;
  let guard: GuestChatGuard;

  beforeEach(() => {
    sessions = mockDeep<GuestSessionService>();
    quota = mockDeep<GuestQuotaService>();
    clientIp = mockDeep<ClientIpService>();
    clientIp.of.mockReturnValue('203.0.113.5');
    guard = new GuestChatGuard(sessions, quota, clientIp);
  });

  it('rejects missing or non-bearer Authorization headers', async () => {
    sessions.verify.mockResolvedValue(null);

    await expect(guard.canActivate(contextWithAuth(undefined))).rejects.toThrow(
      UnauthenticatedException,
    );
    expect(sessions.verify).toHaveBeenCalledWith(undefined);

    await expect(
      guard.canActivate(contextWithAuth('Basic dXNlcjpwYXNz')),
    ).rejects.toThrow(UnauthenticatedException);
    expect(sessions.verify).toHaveBeenLastCalledWith(undefined);
  });

  it('rejects an invalid or expired guest token with UNAUTHORIZED', async () => {
    sessions.verify.mockResolvedValue(null);

    await expect(
      guard.canActivate(contextWithAuth('Bearer bad-token')),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(sessions.verify).toHaveBeenCalledWith('bad-token');
  });

  it('throws FeatureUnavailableException (GUEST_CHAT_CLOSED) when daily budget is spent', async () => {
    sessions.verify.mockResolvedValue('guest-1');
    quota.consume.mockReturnValue('budget');

    await expect(
      guard.canActivate(contextWithAuth('bearer valid-token')),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof FeatureUnavailableException &&
        err.code === 'GUEST_CHAT_CLOSED',
    );
    expect(quota.consume).toHaveBeenCalledWith('guest-1', '203.0.113.5');
  });

  it('throws QuotaReachedException (GUEST_QUOTA_REACHED) on guest or ip cap', async () => {
    sessions.verify.mockResolvedValue('guest-1');
    quota.consume.mockReturnValueOnce('guest').mockReturnValueOnce('ip');

    await expect(
      guard.canActivate(contextWithAuth('Bearer valid-token')),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof QuotaReachedException &&
        err.code === 'GUEST_QUOTA_REACHED',
    );

    await expect(
      guard.canActivate(contextWithAuth('Bearer valid-token')),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof QuotaReachedException &&
        err.code === 'GUEST_QUOTA_REACHED',
    );
  });

  it('allows the request when the session and quota checks pass', async () => {
    sessions.verify.mockResolvedValue('guest-1');
    quota.consume.mockReturnValue('ok');

    await expect(
      guard.canActivate(contextWithAuth('Bearer valid-token')),
    ).resolves.toBe(true);
  });

  it('skips quota consumption for malformed request bodies so ValidationPipe returns 400', async () => {
    sessions.verify.mockResolvedValue('guest-1');
    quota.consume.mockReturnValue('ok');

    await expect(
      guard.canActivate(
        contextWithAuth('Bearer valid-token', { messages: [] }),
      ),
    ).resolves.toBe(true);
    expect(quota.consume).not.toHaveBeenCalled();

    await expect(
      guard.canActivate(
        contextWithAuth('Bearer valid-token', {
          messages: [{ role: 'user', text: 'Đậu phụ có gì?' }],
        }),
      ),
    ).resolves.toBe(true);
    expect(quota.consume).toHaveBeenCalledTimes(1);
  });
});
