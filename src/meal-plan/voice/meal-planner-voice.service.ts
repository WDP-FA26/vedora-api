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
} from '../dto/meal-plan-voice.dto.js';
import {
  MealPlannerChatService,
  type PlannerChatOptions,
} from '../meal-planner-chat.service.js';

const TOKEN_TTL_SECONDS = 60;

type Gateway = ReturnType<typeof createGatewayRealtimeClient>;

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

  async createSession(
    userId: string,
    threadId?: string,
  ): Promise<MealPlanVoiceSessionDto> {
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
    void this.chat.warmVoiceCache(userId, threadId);
    const { token, url, expiresAt } =
      await this.gateway.experimental_realtime.getToken({
        model: this.model,
        expiresAfterSeconds: TOKEN_TTL_SECONDS,
      });
    return { token, url, expiresAt: expiresAt ?? null, model: this.model };
  }

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
}
