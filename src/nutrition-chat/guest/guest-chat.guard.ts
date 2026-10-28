import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ClientIpService } from './client-ip.service.js';
import { GuestQuotaService } from './guest-quota.service.js';
import { GuestSessionService } from './guest-session.service.js';
import { FeatureUnavailableException } from '../../common/exceptions/feature-unavailable.exception.js';
import { QuotaReachedException } from '../../common/exceptions/quota-reached.exception.js';
import { UnauthenticatedException } from '../../common/exceptions/unauthenticated.exception.js';

/** Lets a guest session through while it has messages left today. */
@Injectable()
export class GuestChatGuard implements CanActivate {
  constructor(
    private readonly sessions: GuestSessionService,
    private readonly quota: GuestQuotaService,
    private readonly clientIp: ClientIpService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    const guestId = await this.sessions.verify(
      type?.toLowerCase() === 'bearer' ? token : undefined,
    );
    if (!guestId)
      throw new UnauthenticatedException(
        'UNAUTHORIZED',
        'Guest session required',
      );

    const verdict = this.quota.consume(guestId, this.clientIp.of(request));
    if (verdict === 'budget') {
      throw new FeatureUnavailableException(
        'GUEST_CHAT_CLOSED',
        'The guest chat is closed for today',
      );
    }
    if (verdict !== 'ok') {
      throw new QuotaReachedException(
        'GUEST_QUOTA_REACHED',
        'No guest messages left today',
      );
    }
    return true;
  }
}
