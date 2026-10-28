import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { SePayProvider } from './sepay.provider.js';

@Injectable()
export class SePayWebhookGuard implements CanActivate {
  constructor(private readonly provider: SePayProvider) {}
  canActivate(context: ExecutionContext): boolean {
    this.provider.verifyWebhook(
      context.switchToHttp().getRequest<Request>().headers.authorization,
    );
    return true;
  }
}
