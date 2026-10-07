import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/**
 * The visitor's address. Behind Cloudflare the socket address is the
 * tunnel's, so `CLIENT_IP_HEADER` names the header Cloudflare sets
 * (`cf-connecting-ip`). Only set it when nothing but that proxy can reach the
 * API: anyone connecting directly could send the header themselves.
 */
@Injectable()
export class ClientIpService {
  private readonly header: string;

  constructor(configService: ConfigService) {
    this.header = configService
      .get<string>('CLIENT_IP_HEADER', '')
      .toLowerCase();
  }

  of(request: Request): string {
    const forwarded = this.header ? request.headers[this.header] : undefined;
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return value?.trim() || request.ip || 'unknown';
  }
}
