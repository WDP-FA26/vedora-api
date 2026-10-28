import { ConfigService } from '@nestjs/config';
import { GuestQuotaService } from './guest-quota.service.js';

function quota(caps: Record<string, number> = {}) {
  return new GuestQuotaService(
    new ConfigService({
      GUEST_DAILY_MESSAGES: 2,
      GUEST_DAILY_MESSAGES_PER_IP: 3,
      GUEST_DAILY_BUDGET: 100,
      ...caps,
    }),
  );
}

describe('GuestQuotaService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops a guest at the per-session cap', () => {
    const service = quota();

    expect(service.consume('a', '1.1.1.1')).toBe('ok');
    expect(service.remaining('a', '1.1.1.1')).toBe(1);
    expect(service.consume('a', '1.1.1.1')).toBe('ok');
    expect(service.consume('a', '1.1.1.1')).toBe('guest');
  });

  it('stops new sessions from an address that used up its share', () => {
    const service = quota();
    service.consume('a', '1.1.1.1');
    service.consume('a', '1.1.1.1');
    service.consume('b', '1.1.1.1');

    expect(service.consume('c', '1.1.1.1')).toBe('ip');
    expect(service.consume('c', '2.2.2.2')).toBe('ok');
  });

  it('closes the chat for everyone once the daily budget is spent', () => {
    const service = quota({ GUEST_DAILY_BUDGET: 1 });
    service.consume('a', '1.1.1.1');

    expect(service.consume('b', '2.2.2.2')).toBe('budget');
  });

  it('starts over the next day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T23:00:00Z'));
    const service = quota();
    service.consume('a', '1.1.1.1');
    service.consume('a', '1.1.1.1');

    vi.setSystemTime(new Date('2026-10-08T00:01:00Z'));

    expect(service.consume('a', '1.1.1.1')).toBe('ok');
  });
});
