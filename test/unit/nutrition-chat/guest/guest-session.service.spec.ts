import { JwtService } from '@nestjs/jwt';
import {
  GUEST_SESSION_TTL_SEC,
  GuestSessionService,
} from '@src/nutrition-chat/guest/guest-session.service.js';

describe('GuestSessionService', () => {
  let jwtService: JwtService;
  let service: GuestSessionService;

  beforeEach(() => {
    jwtService = new JwtService({
      secret: 'test-guest-hmac-secret-key-32chars',
    });
    service = new GuestSessionService(jwtService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues a signed guest JWT with audience and 24h TTL that verifies to a UUID', async () => {
    const token = await service.issue();
    const guestId = await service.verify(token);

    expect(guestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const decoded = jwtService.decode<{
      aud?: string;
      exp?: number;
      iat?: number;
    }>(token);
    expect(decoded.aud).toBe('guest');
    expect((decoded.exp ?? 0) - (decoded.iat ?? 0)).toBe(GUEST_SESSION_TTL_SEC);
  });

  it('returns null when token is missing or empty', async () => {
    await expect(service.verify(undefined)).resolves.toBeNull();
    await expect(service.verify('')).resolves.toBeNull();
  });

  it('rejects a tampered token or one signed with another secret', async () => {
    const token = await service.issue();
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.tampered-signature`;
    await expect(service.verify(tampered)).resolves.toBeNull();

    const otherJwt = new JwtService({ secret: 'different-secret' });
    const foreignToken = await otherJwt.signAsync(
      { sub: 'guest-1' },
      { audience: 'guest', expiresIn: 60 },
    );
    await expect(service.verify(foreignToken)).resolves.toBeNull();
  });

  it('rejects a token with a wrong audience', async () => {
    const wrongAudToken = await jwtService.signAsync(
      { sub: 'guest-1' },
      { audience: 'member', expiresIn: 60 },
    );

    await expect(service.verify(wrongAudToken)).resolves.toBeNull();
  });

  it('rejects an expired token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const token = await service.issue();

    vi.advanceTimersByTime((GUEST_SESSION_TTL_SEC + 1) * 1000);

    await expect(service.verify(token)).resolves.toBeNull();
  });

  it('returns null when sub claim is not a string', async () => {
    const nonStringSubToken = await jwtService.signAsync(
      { sub: 12345 },
      { audience: 'guest', expiresIn: 60 },
    );

    await expect(service.verify(nonStringSubToken)).resolves.toBeNull();
  });
});
