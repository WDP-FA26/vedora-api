import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isStepCount,
  type LanguageModel,
  ToolLoopAgent,
  toUIMessageStream,
} from 'ai';
import { cannedReply } from '../ai/chat/canned-reply.js';
import { chatErrorCode } from '../ai/chat/errors.js';
import { replyFilter } from '../ai/chat/reply-filter.js';
import { moderateWithRetry } from '../ai/moderation/moderation.js';
import { NUTRITION_POLICY } from '../ai/moderation/policies/nutrition.js';
import {
  chatModel,
  DEFAULT_CHAT_MODEL,
  DEFAULT_MODERATION_MODEL,
} from '../ai/openrouter.js';
import type { ReasoningEffort } from '../ai/reasoning.js';
import { searchKnowledgeTool } from '../ai/tools/search-knowledge.tool.js';
import { KnowledgeSearchService } from '../knowledge/retrieval/knowledge-search.service.js';
import { DietaryService } from '../recipes/dietary.service.js';
import type { PlannerMessageDto } from './dto/meal-plan.dto.js';
import { MealPlanService } from './meal-plan.service.js';
import { plannerInstructions } from './meal-planner.prompt.js';
import { PLANNER_REFUSALS } from './meal-planner.refusals.js';
import { proposeMealPlanTool } from './tools/propose-meal-plan.tool.js';
import { searchRecipesTool } from './tools/search-recipes.tool.js';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';

// room to search, then propose again after a rejected proposal
const MAX_STEPS = 8;
const SEARCH_TIMEOUT_MS = 5000;

/**
 * Vedora's assistant for signed-in users: it plans the weekly timetable
 * (reading the user's restrictions, asking what it needs, proposing changes
 * that only the user saves) and answers nutrition questions from the knowledge
 * base. The guest-facing nutrition chat stays a separate, narrower agent.
 */
@Injectable()
export class MealPlannerChatService {
  private readonly logger = new Logger(MealPlannerChatService.name);
  private readonly model: LanguageModel;
  private readonly moderationModel: LanguageModel;

  constructor(
    configService: ConfigService,
    private readonly mealPlan: MealPlanService,
    private readonly dietary: DietaryService,
    private readonly knowledge: KnowledgeSearchService,
  ) {
    const apiKey = configService.getOrThrow<string>('OPENROUTER_API_KEY');
    this.moderationModel = chatModel({
      apiKey,
      modelId: configService.get<string>(
        'OPENROUTER_MODERATION_MODEL',
        DEFAULT_MODERATION_MODEL,
      ),
      reasoningEffort: 'low',
    });
    this.model = chatModel({
      apiKey,
      modelId: configService.get<string>(
        'OPENROUTER_MODEL',
        DEFAULT_CHAT_MODEL,
      ),
      reasoningEffort: configService.get<ReasoningEffort>(
        'OPENROUTER_REASONING_EFFORT',
        'low',
      ),
    });
  }

  async stream(
    userId: string,
    messages: PlannerMessageDto[],
    abortSignal: AbortSignal,
  ) {
    const verdict = await moderateWithRetry(
      this.moderationModel,
      messages.at(-1)?.text ?? '',
      abortSignal,
      NUTRITION_POLICY,
    ).catch((error: unknown) => {
      if (abortSignal.aborted) throw error;
      this.logger.error(`Moderation failed: ${String(error)}`);
      throw new FeatureUnavailableException(
        'SERVICE_UNAVAILABLE',
        'Moderation is unavailable',
      );
    });
    if (verdict !== 'allow') {
      this.logger.warn(`Moderation answered ${verdict}`);
      return cannedReply(PLANNER_REFUSALS[verdict]);
    }

    const [restrictions, plan] = await Promise.all([
      this.dietary.find(userId),
      this.mealPlan.find(userId),
    ]);
    const agent = new ToolLoopAgent({
      model: this.model,
      instructions: plannerInstructions(restrictions, plan),
      tools: {
        searchKnowledge: searchKnowledgeTool(this.knowledge),
        searchRecipes: searchRecipesTool(this.mealPlan, userId),
        proposeMealPlan: proposeMealPlanTool(this.mealPlan, userId),
      },
      stopWhen: isStepCount(MAX_STEPS),
      prepareStep: ({ stepNumber }) =>
        stepNumber === MAX_STEPS - 1 ? { toolChoice: 'none' } : {},
    });

    const result = await agent.stream({
      messages: messages.map(({ role, text }) => ({ role, content: text })),
      abortSignal,
      timeout: { tools: { searchKnowledgeMs: SEARCH_TIMEOUT_MS } },
      experimental_transform: replyFilter(),
    });
    return toUIMessageStream({
      stream: result.stream,
      tools: agent.tools,
      onError: (error) => {
        this.logger.error(
          `Meal planner stream failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return chatErrorCode(error);
      },
    });
  }
}
