import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { pipeUIMessageStreamToResponse } from 'ai';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../auth-core/auth.types.js';
import { JwtAuthGuard } from '../../auth-core/jwt-auth.guard.js';
import { UserThrottlerGuard } from '../../auth-core/user-throttler.guard.js';
import { ErrorBodyDto } from '../../common/exceptions/error-body.dto.js';
import {
  MealPlanVoiceSessionDto,
  MealPlanVoiceSessionRequestDto,
  MealPlanVoiceTurnRequestDto,
} from '../dto/meal-plan-voice.dto.js';
import { MealPlannerVoiceService } from './meal-planner-voice.service.js';

@ApiTags('meal-plan')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ErrorBodyDto,
  description: 'Authentication required',
})
@ApiTooManyRequestsResponse({
  type: ErrorBodyDto,
  description: 'Too many voice requests a minute',
})
@ApiForbiddenResponse({
  type: ErrorBodyDto,
  description: 'PRO_REQUIRED: an active Pro subscription is required',
})
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
@Controller('meal-plan/voice')
export class MealPlannerVoiceController {
  constructor(private readonly voice: MealPlannerVoiceService) {}

  @Post('session')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start a voice session with the meal planner',
    description:
      'Requires an active Pro subscription before minting a short-lived AI Gateway client secret. Existing Pro subscriptions qualify. Voice requests do not consume the shared text allowance; there is no subscription minutes quota.',
  })
  @ApiOkResponse({ type: MealPlanVoiceSessionDto })
  @ApiServiceUnavailableResponse({
    type: ErrorBodyDto,
    description: 'Voice is not configured (no AI_GATEWAY_API_KEY)',
  })
  createSession(
    @Req() request: AuthenticatedRequest,
    @Body() dto?: MealPlanVoiceSessionRequestDto,
  ): Promise<MealPlanVoiceSessionDto> {
    return this.voice.createSession(request.user.sub, dto?.threadId);
  }

  @Post('turns')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Answer one spoken turn with the meal planner',
    description:
      'Streams the meal planner agent in voice mode on what the user said, as an AI SDK UI message stream (SSE) enriched with transient `data-*` events (`data-state`, `data-screen`, `data-progress`, `data-summary`, `data-end-call`). Send `screen` with what the page shows now so the agent can refer to it. The reply text is short and meant to be spoken. Closing the request stops the agent (the user spoke again or hung up); what was saved stays. Requires an active Pro subscription and uses the independent VOICE request channel without charging shared text quota; skips the extra moderation round-trip for voice latency.',
  })
  @ApiOkResponse({ description: 'UI message stream (text/event-stream)' })
  @ApiServiceUnavailableResponse({
    type: ErrorBodyDto,
    description: 'The planner model failed',
  })
  async turn(
    @Req() request: AuthenticatedRequest,
    @Body() dto: MealPlanVoiceTurnRequestDto,
    @Res() response: Response,
  ): Promise<void> {
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    await pipeUIMessageStreamToResponse({
      response,
      stream: await this.voice.turn(request.user.sub, dto, abort.signal),
    });
  }
}
