import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { StorageService } from './storage.service.js';

@Injectable()
export class StorageWebhookGuard implements CanActivate {
  private readonly logger = new Logger(StorageWebhookGuard.name);

  constructor(private readonly storage: StorageService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expected = Buffer.from(this.storage.webhookToken);
    const token = Buffer.from(
      request.headers.authorization?.replace(/^Bearer /, '') ?? '',
    );
    if (
      expected.length > 0 &&
      token.length === expected.length &&
      timingSafeEqual(token, expected)
    )
      return true;
    this.logger.warn(`Rejected a storage event for ${request.path}`);
    throw new UnauthorizedException();
  }
}
