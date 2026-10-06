import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { mockDeep } from 'vitest-mock-extended';
import { StorageWebhookGuard } from './storage-webhook.guard';
import { StorageService } from './storage.service';

function contextWith(authorization?: string): ExecutionContext {
  return new ExecutionContextHost([
    { headers: { authorization }, path: '/api/v1/webhooks/storage/knowledge' },
  ]);
}

describe('StorageWebhookGuard', () => {
  function guardWith(webhookToken: string): StorageWebhookGuard {
    return new StorageWebhookGuard(mockDeep<StorageService>({ webhookToken }));
  }

  it("lets RustFS's bearer token through", () => {
    expect(
      guardWith('webhook-token').canActivate(
        contextWith('Bearer webhook-token'),
      ),
    ).toBe(true);
  });

  it.each([undefined, 'Bearer wrong', 'webhook-token!'])(
    'rejects %s',
    (authorization) => {
      expect(() =>
        guardWith('webhook-token').canActivate(contextWith(authorization)),
      ).toThrow(UnauthorizedException);
    },
  );

  it('rejects everything while no token is configured', () => {
    expect(() => guardWith('').canActivate(contextWith('Bearer '))).toThrow(
      UnauthorizedException,
    );
  });
});
