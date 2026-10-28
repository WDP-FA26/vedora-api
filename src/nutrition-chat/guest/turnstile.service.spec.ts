import { ConfigService } from '@nestjs/config';
import { TurnstileService } from './turnstile.service.js';

describe('Turnstile server verification', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let service: TurnstileService;
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    service = new TurnstileService(
      new ConfigService({ TURNSTILE_SECRET_KEY: 'server-only-secret' }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends token and server secret to Siteverify, omitting unknown visitor IP', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true }));
    await expect(service.verify('browser-proof', undefined)).resolves.toBe(
      true,
    );
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    );
    const body = options?.body as URLSearchParams;
    expect(body.get('secret')).toBe('server-only-secret');
    expect(body.get('response')).toBe('browser-proof');
    expect(body.has('remoteip')).toBe(false);
  });

  it('keeps the guest chat visitor IP when supplied', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true }));
    await service.verify('guest-proof', '192.0.2.1');
    expect(
      (fetchMock.mock.calls[0][1]?.body as URLSearchParams).get('remoteip'),
    ).toBe('192.0.2.1');
  });

  it.each([{ success: false }, {}, { success: 'true' }])(
    'rejects unsuccessful or malformed results: %j',
    async (result) => {
      fetchMock.mockResolvedValue(Response.json(result));
      await expect(service.verify('proof', undefined)).resolves.toBe(false);
    },
  );

  it('rejects a non-2xx provider response even if its body claims success', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ success: true }, { status: 503 }),
    );
    await expect(service.verify('proof', undefined)).resolves.toBe(false);
  });

  it.each([
    new Error('Provider unavailable'),
    new DOMException('Timed out', 'TimeoutError'),
  ])('fails closed on network/timeout errors', async (error) => {
    fetchMock.mockRejectedValue(error);
    await expect(service.verify('proof', undefined)).resolves.toBe(false);
  });
});
