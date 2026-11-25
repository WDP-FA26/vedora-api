import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type UIMessageChunk } from 'ai';
import { MODERATION_MODEL } from '../../ai/guardrails/guardrail.js';
import { createGatewayRealtimeClient } from '../../ai/providers/provider-registry.js';
import { decide, type DecisionModel } from '../../common/decision/decision.js';
import { FeatureUnavailableException } from '../../common/exceptions/feature-unavailable.exception.js';
import { QuotaReachedException } from '../../common/exceptions/quota-reached.exception.js';
import { AiFeature } from '../../mongo/models.js';
import { AiUsageService } from '../../subscriptions/ai-usage.service.js';
import type {
  MealPlanVoiceInterruptionRequestDto,
  MealPlanVoiceSessionDto,
  MealPlanVoiceTurnRequestDto,
  VoiceInterruption,
} from '../dto/meal-plan-voice.dto.js';
import {
  MealPlannerChatService,
  type PlannerChatOptions,
} from '../meal-planner-chat.service.js';
import { VOICE_INTERRUPTION_POLICY } from './voice-interruption.js';

/** Long enough to open the WebSocket; an open session keeps going after it. */
const TOKEN_TTL_SECONDS = 60;

type Gateway = ReturnType<typeof createGatewayRealtimeClient>;

/**
 * The meal planner's voice agent. The browser talks to the realtime model
 * through Vercel AI Gateway with a short-lived token from `createSession`;
 * whenever the model delegates work, the browser sends the user's words to
 * `turn`, which streams the same planner agent as the text chat, in voice mode.
 */
@Injectable()
export class MealPlannerVoiceService {
  private readonly logger = new Logger(MealPlannerVoiceService.name);
  private readonly gateway: Gateway | null;
  private readonly model: string;

  constructor(
    config: ConfigService,
    private readonly chat: MealPlannerChatService,
    @Inject(MODERATION_MODEL) private readonly decisionModel: DecisionModel,
    private readonly usage: AiUsageService,
  ) {
    const apiKey = config.get<string>('AI_GATEWAY_API_KEY', '');
    this.gateway = apiKey ? createGatewayRealtimeClient(apiKey) : null;
    this.model = config.get<string>(
      'VOICE_REALTIME_MODEL',
      'openai/gpt-live-1.1',
    );
  }

  /**
   * Every spoken request runs on the meal planner chat quota, so a user with none
   * left gets no session: the call would connect and then fail on every turn.
   * Admins are never limited, as in the text chat.
   */
  async createSession(userId: string): Promise<MealPlanVoiceSessionDto> {
    if (!this.gateway) {
      throw new FeatureUnavailableException(
        'SERVICE_UNAVAILABLE',
        'Voice is not configured',
      );
    }
    const allowed = await this.usage.hasAllowance(
      userId,
      AiFeature.MEAL_PLAN_CHAT,
    );
    if (!allowed) {
      throw new QuotaReachedException(
        'AI_QUOTA_EXCEEDED',
        'Your shared AI text allowance is exhausted',
      );
    }
    const { token, url, expiresAt } =
      await this.gateway.experimental_realtime.getToken({
        model: this.model,
        expiresAfterSeconds: TOKEN_TTL_SECONDS,
      });
    return { token, url, expiresAt: expiresAt ?? null, model: this.model };
  }

  /**
   * One spoken turn as an AI SDK UI message stream, the same as the text chat's.
   * Web search stays off in voice mode to avoid extra round trips and keep spoken
   * latency low.
   */
  async turn(
    userId: string,
    dto: MealPlanVoiceTurnRequestDto,
    abortSignal: AbortSignal,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const options: PlannerChatOptions = { voice: true };
    if (dto.screen) options.screen = dto.screen;
    return this.chat.stream(
      userId,
      dto.message,
      abortSignal,
      dto.weekStart,
      dto.requestId,
      dto.threadId ?? randomUUID(),
      options,
    );
  }

  /**
   * What the user's new words mean for the turn still running. Without a reading
   * the running turn is superseded, as before this check existed: a correction
   * that is ignored saves data the user did not want.
   */
  async interruption(
    dto: MealPlanVoiceInterruptionRequestDto,
    abortSignal: AbortSignal,
  ): Promise<VoiceInterruption> {
    try {
      const { choice } = await decide(
        this.decisionModel,
        [
          { role: 'user', text: dto.running },
          { role: 'assistant', text: 'Mình đang làm, bạn đợi mình chút nhé.' },
          { role: 'user', text: dto.utterance },
        ],
        abortSignal,
        VOICE_INTERRUPTION_POLICY,
      );
      return choice;
    } catch (error) {
      if (abortSignal.aborted) throw error;
      this.logger.warn(`Voice interruption check failed: ${String(error)}`);
      return 'supersede';
    }
  }
}
