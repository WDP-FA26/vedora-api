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
  MealPlanVoiceInterruptionDto,
  MealPlanVoiceInterruptionRequestDto,
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
  description:
    'Too many requests a minute, or `AI_QUOTA_EXCEEDED` when the shared AI text allowance is used up',
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
      'Mints a short-lived Vercel AI Gateway client secret for the realtime voice model (GPT-Live by default). The browser opens the WebSocket with it; the voice model delegates the actual work to `POST /meal-plan/voice/turns`. Refused with `429 AI_QUOTA_EXCEEDED` when the meal planner chat quota is used up, since every turn would fail.',
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

  @Post('interruptions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Read words spoken while a voice turn is still running',
    description:
      'Decision-model classification is disabled for voice latency; always returns `supersede` immediately so the client can abort the in-flight turn and run the new utterance without an extra LLM round-trip. Does not use the chat quota.',
  })
  @ApiOkResponse({ type: MealPlanVoiceInterruptionDto })
  interruption(
    @Body() _dto: MealPlanVoiceInterruptionRequestDto,
  ): MealPlanVoiceInterruptionDto {
    return { action: this.voice.interruption() };
  }

  @Post('turns')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Answer one spoken turn with the meal planner',
    description:
      'Streams the meal planner agent in voice mode on what the user said, as an AI SDK UI message stream (SSE), the same format as `POST /meal-plan/chat`. Read each tool output as it finishes to update the screen: plan tools save as in the text chat; `logMeal`, `updateBodyMetrics` and `undoLastChange` write; `setScreen` only says what the page should show. Send `screen` with what the page shows now so the agent can refer to it. The reply text is short and meant to be spoken. Closing the request stops the agent (the user spoke again or hung up); what was saved stays. Uses the meal planner chat quota; skips web search and the extra moderation round-trip for voice latency.',
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
