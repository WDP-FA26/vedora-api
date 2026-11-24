import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { ClientIpService } from '@src/nutrition-chat/guest/client-ip.service.js';

const request = (
  headers: Record<string, string | string[]>,
  ip: string | undefined = '10.0.0.2',
) => ({ headers, ip }) as unknown as Request;

const requestWithoutIp = (headers: Record<string, string | string[]>) =>
  ({ headers }) as unknown as Request;

describe('ClientIpService', () => {
  it('reads the configured header, whatever its case in the setting', () => {
    const service = new ClientIpService(
      new ConfigService({ CLIENT_IP_HEADER: 'CF-Connecting-IP' }),
    );

    expect(service.of(request({ 'cf-connecting-ip': '203.0.113.7' }))).toBe(
      '203.0.113.7',
    );
  });

  it('uses the first element when the configured header is an array', () => {
    const service = new ClientIpService(
      new ConfigService({ CLIENT_IP_HEADER: 'X-Forwarded-For' }),
    );

    expect(
      service.of(
        request({ 'x-forwarded-for': [' 198.51.100.4 ', '10.0.0.1'] }),
      ),
    ).toBe('198.51.100.4');
  });

  it('falls back to the socket address when the header is missing or blank', () => {
    const service = new ClientIpService(
      new ConfigService({ CLIENT_IP_HEADER: 'cf-connecting-ip' }),
    );

    expect(service.of(request({}))).toBe('10.0.0.2');
    expect(service.of(request({ 'cf-connecting-ip': '   ' }))).toBe('10.0.0.2');
  });

  it('returns unknown when both header and socket address are missing', () => {
    const service = new ClientIpService(
      new ConfigService({ CLIENT_IP_HEADER: 'cf-connecting-ip' }),
    );

    expect(service.of(requestWithoutIp({}))).toBe('unknown');
  });

  it('ignores the header when none is configured', () => {
    const service = new ClientIpService(new ConfigService({}));

    expect(service.of(request({ 'cf-connecting-ip': '203.0.113.7' }))).toBe(
      '10.0.0.2',
    );
  });
});
