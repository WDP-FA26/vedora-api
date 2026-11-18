import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request } from 'express';
import { ClientIpService } from './client-ip.service.js';
import { GuestQuotaService } from './guest-quota.service.js';
import { GuestSessionService } from './guest-session.service.js';
import { NutritionChatDto } from '../dto/nutrition-chat.dto.js';
import { FeatureUnavailableException } from '../../common/exceptions/feature-unavailable.exception.js';
import { QuotaReachedException } from '../../common/exceptions/quota-reached.exception.js';
import { UnauthenticatedException } from '../../common/exceptions/unauthenticated.exception.js';

@Injectable()
export class GuestChatGuard implements CanActivate {
  constructor(
    private readonly sessions: GuestSessionService,
    private readonly quota: GuestQuotaService,
    private readonly clientIp: ClientIpService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request<Record<string, string>, unknown, unknown>>();
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    const guestId = await this.sessions.verify(
      type?.toLowerCase() === 'bearer' ? token : undefined,
    );
    if (!guestId)
      throw new UnauthenticatedException(
        'UNAUTHORIZED',
        'Guest session required',
      );

    // Let ValidationPipe reject malformed bodies with 400 before spending quota.
    if (request.body !== undefined) {
      if (
        typeof request.body !== 'object' ||
        request.body === null ||
        Array.isArray(request.body)
      ) {
        return true;
      }
      const dto = plainToInstance(NutritionChatDto, request.body);
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      if (errors.length > 0) return true;
    }

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
