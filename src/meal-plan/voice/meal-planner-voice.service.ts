import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type UIMessageChunk } from 'ai';
import { createGatewayRealtimeClient } from '../../ai/providers/provider-registry.js';
import { FeatureUnavailableException } from '../../common/exceptions/feature-unavailable.exception.js';
import { QuotaReachedException } from '../../common/exceptions/quota-reached.exception.js';
import { AiFeature } from '../../mongo/models.js';
import { AiUsageService } from '../../subscriptions/ai-usage.service.js';
import type {
  MealPlanVoiceSessionDto,
  MealPlanVoiceTurnRequestDto,
  VoiceInterruption,
} from '../dto/meal-plan-voice.dto.js';
import {
  MealPlannerChatService,
  type PlannerChatOptions,
} from '../meal-planner-chat.service.js';

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
  private readonly gateway: Gateway | null;
  private readonly model: string;

  constructor(
    config: ConfigService,
    private readonly chat: MealPlannerChatService,
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
   * Interruption classification via the decision model is disabled for voice
   * latency: any new delegated utterance immediately supersedes the in-flight
   * turn, and anything already saved stays saved.
   */
  interruption(): VoiceInterruption {
    return 'supersede';
  }
}
