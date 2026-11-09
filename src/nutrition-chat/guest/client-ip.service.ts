import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

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
