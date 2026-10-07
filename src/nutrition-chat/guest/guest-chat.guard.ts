import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClientIpService } from './client-ip.service';
import { GuestQuotaService } from './guest-quota.service';
import { GuestSessionService } from './guest-session.service';

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
    if (!guestId) throw new UnauthorizedException('Guest session required');

    const verdict = this.quota.consume(guestId, this.clientIp.of(request));
    if (verdict === 'budget') {
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'GUEST_CHAT_CLOSED',
        message: 'The guest chat is closed for today',
      });
    }
    if (verdict !== 'ok') {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'GUEST_QUOTA_REACHED',
          message: 'No guest messages left today',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
