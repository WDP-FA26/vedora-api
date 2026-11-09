import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/ai';
import {
  type Experimental_EvaluationModel,
  isStepCount,
  type LanguageModel,
  ToolLoopAgent,
  toUIMessageStream,
} from 'ai';
import { cannedReply } from '../ai/chat/canned-reply.js';
import { chatErrorCode } from '../ai/chat/errors.js';
import { replyFilter } from '../ai/chat/reply-filter.js';
import { MODERATION_MODEL } from '../ai/guardrails/guardrail.js';
import { decide } from '../common/decision/decision.js';
import { NUTRITION_POLICY } from '../ai/guardrails/policies/nutrition.js';
import { searchKnowledgeTool } from '../knowledge/tools/search-knowledge.tool.js';
import { KnowledgeSearchService } from '../knowledge/retrieval/knowledge-search.service.js';
import { DietaryService } from '../recipes/dietary.service.js';
import type { PlannerMessageDto } from './dto/meal-plan.dto.js';
import { MealPlanService } from './meal-plan.service.js';
import { plannerInstructions } from './meal-planner.prompt.js';
import { PLANNER_REFUSALS } from './meal-planner.refusals.js';
import { proposeMealPlanTool } from './tools/propose-meal-plan.tool.js';
import { searchRecipesTool } from './tools/search-recipes.tool.js';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';

const MAX_STEPS = 8;
const SEARCH_TIMEOUT_MS = 5000;

@Injectable()
export class MealPlannerChatService {
  private readonly logger = new Logger(MealPlannerChatService.name);

  constructor(
    @Inject(MODERATION_MODEL)
    private readonly moderator: Experimental_EvaluationModel,
    @InjectModel() private readonly model: LanguageModel,
    private readonly mealPlan: MealPlanService,
    private readonly dietary: DietaryService,
    private readonly knowledge: KnowledgeSearchService,
  ) {}

  async stream(
    userId: string,
    messages: PlannerMessageDto[],
    abortSignal: AbortSignal,
  ) {
    const { choice: verdict } = await decide(
      this.moderator,
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
