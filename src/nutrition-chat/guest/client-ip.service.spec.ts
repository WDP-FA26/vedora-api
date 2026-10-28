import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { ClientIpService } from './client-ip.service.js';

const request = (headers: Record<string, string>) =>
  ({ headers, ip: '10.0.0.2' }) as unknown as Request;

describe('ClientIpService', () => {
  it('reads the configured header, whatever its case in the setting', () => {
    const service = new ClientIpService(
      new ConfigService({ CLIENT_IP_HEADER: 'CF-Connecting-IP' }),
    );

    expect(service.of(request({ 'cf-connecting-ip': '203.0.113.7' }))).toBe(
      '203.0.113.7',
    );
  });

  it('falls back to the socket address when the header is missing', () => {
    const service = new ClientIpService(
      new ConfigService({ CLIENT_IP_HEADER: 'cf-connecting-ip' }),
    );

    expect(service.of(request({}))).toBe('10.0.0.2');
  });

  it('ignores the header when none is configured', () => {
    const service = new ClientIpService(new ConfigService({}));

    expect(service.of(request({ 'cf-connecting-ip': '203.0.113.7' }))).toBe(
      '10.0.0.2',
    );
  });
});
