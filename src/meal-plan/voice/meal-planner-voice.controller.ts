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
  MealPlanVoiceSessionDto,
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
  description: 'Too many requests a minute',
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
      'Mints a short-lived Vercel AI Gateway client secret for the realtime voice model (GPT-Live by default). The browser opens the WebSocket with it; the voice model delegates the actual work to `POST /meal-plan/voice/turns`.',
  })
  @ApiOkResponse({ type: MealPlanVoiceSessionDto })
  @ApiServiceUnavailableResponse({
    type: ErrorBodyDto,
    description: 'Voice is not configured (no AI_GATEWAY_API_KEY)',
  })
  createSession(): Promise<MealPlanVoiceSessionDto> {
    return this.voice.createSession();
  }

  @Post('turns')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Answer one spoken turn with the meal planner',
    description:
      'Streams the meal planner agent in voice mode on what the user said, as an AI SDK UI message stream (SSE), the same format as `POST /meal-plan/chat`. Read each tool output as it finishes to update the screen: plan tools save as in the text chat; `logMeal`, `updateBodyMetrics` and `undoLastChange` write; `showRecipe`, `openEatingLog` and `showBodyMetrics` only say what to show. The reply text is short and meant to be spoken. A turn that ends on `requestWebSearch` waits for the spoken answer: send it next with `webSearchRequest`. Closing the request stops the agent (the user spoke again or hung up); what was saved stays. Uses the meal planner chat quota and moderation.',
  })
  @ApiOkResponse({ description: 'UI message stream (text/event-stream)' })
  @ApiServiceUnavailableResponse({
    type: ErrorBodyDto,
    description: 'Moderation or the planner model failed',
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
