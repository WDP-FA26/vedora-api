import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { pipeUIMessageStreamToResponse } from 'ai';
import type { Request, Response } from 'express';
import {
  CreateGuestSessionDto,
  GuestSessionDto,
  NutritionChatDto,
} from './dto/nutrition-chat.dto.js';
import { ClientIpService } from './guest/client-ip.service.js';
import { GuestChatGuard } from './guest/guest-chat.guard.js';
import { GuestQuotaService } from './guest/guest-quota.service.js';
import {
  GUEST_SESSION_TTL_SEC,
  GuestSessionService,
} from './guest/guest-session.service.js';
import { TurnstileService } from './guest/turnstile.service.js';
import { NutritionChatService } from './nutrition-chat.service.js';
import { AccessDeniedException } from '../common/exceptions/access-denied.exception.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';

/**
 * The landing page's nutrition chat, open to guests. A visitor trades a
 * Turnstile token for a guest session, then spends its daily messages here;
 * signed-in users talk to the assistant at `/meal-plan/chat` instead.
 */
@ApiTags('nutrition-chat')
@Controller('nutrition-chat')
export class NutritionChatController {
  constructor(
    private readonly nutritionChatService: NutritionChatService,
    private readonly turnstile: TurnstileService,
    private readonly sessions: GuestSessionService,
    private readonly quota: GuestQuotaService,
    private readonly clientIp: ClientIpService,
  ) {}

  @Post('guest-session')
  @ApiOperation({ summary: 'Start a guest session after a Turnstile check' })
  @ApiCreatedResponse({ type: GuestSessionDto })
  @ApiForbiddenResponse({
    type: ErrorBodyDto,
    description: 'The Turnstile token did not verify',
  })
  async createGuestSession(
    @Req() request: Request,
    @Body() dto: CreateGuestSessionDto,
  ): Promise<GuestSessionDto> {
    const ip = this.clientIp.of(request);
    if (!(await this.turnstile.verify(dto.turnstileToken, ip))) {
      throw new AccessDeniedException('FORBIDDEN', 'Verification failed');
    }
    const token = await this.sessions.issue();
    const guestId = await this.sessions.verify(token);
    return {
      token,
      expiresIn: GUEST_SESSION_TTL_SEC,
      remaining: guestId ? this.quota.remaining(guestId, ip) : 0,
    };
  }

  @Post()
  @UseGuards(GuestChatGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Ask the nutrition assistant as a guest',
    description:
      'Streams the reply as an AI SDK UI message stream (SSE) for `useChat`. Every message, refused ones included, counts against the daily quota.',
  })
  @ApiUnauthorizedResponse({
    type: ErrorBodyDto,
    description: 'No valid guest session',
  })
  @ApiTooManyRequestsResponse({
    type: ErrorBodyDto,
    description: '`GUEST_QUOTA_REACHED`: none left today for this guest or IP',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorBodyDto,
    description:
      '`GUEST_CHAT_CLOSED`: the daily budget for all guests is spent. Otherwise the moderation model failed or timed out',
  })
  async chat(
    @Body() dto: NutritionChatDto,
    @Res() response: Response,
  ): Promise<void> {
    const abort = new AbortController();
    response.on('close', () => abort.abort());

    await pipeUIMessageStreamToResponse({
      response,
      stream: await this.nutritionChatService.stream(
        dto.messages,
        abort.signal,
      ),
    });
  }
}
