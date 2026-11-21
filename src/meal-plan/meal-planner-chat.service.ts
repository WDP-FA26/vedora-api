import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { runtimeConfig } from '../config/runtime-config.js';
import { InjectModel } from '@nestjs/ai';
import {
  type Experimental_EvaluationModel,
  isStepCount,
  type LanguageModel,
  ToolLoopAgent,
  type ToolSet,
  toUIMessageStream,
} from 'ai';
import { cannedReply } from '../ai/chat/canned-reply.js';
import { chatErrorCode } from '../ai/chat/errors.js';
import { replyFilter } from '../ai/chat/reply-filter.js';
import {
  assertLastMessageFromUser,
  conversationModerationState,
} from '../ai/guardrails/conversation-state.js';
import { MODERATION_MODEL } from '../ai/guardrails/guardrail.js';
import { decide } from '../common/decision/decision.js';
import { NUTRITION_POLICY } from '../ai/guardrails/policies/nutrition.js';
import { searchKnowledgeTool } from '../knowledge/tools/search-knowledge.tool.js';
import { KnowledgeSearchService } from '../knowledge/retrieval/knowledge-search.service.js';
import { DietaryService } from '../recipes/dietary.service.js';
import type { PlannerMessageDto } from './dto/meal-plan.dto.js';
import { MealPlanService } from './meal-plan.service.js';
import { MealPlannerChatHistoryService } from './meal-planner-chat-history.service.js';
import { plannerInstructions } from './meal-planner.prompt.js';
import { PLANNER_REFUSALS } from './meal-planner.refusals.js';
import { editDraftTool } from './tools/edit-draft.tool.js';
import { verifyMealPlanAllergiesTool } from './tools/allergy-verifier-subagent.tool.js';
import { autoBalanceDraftTool } from './tools/auto-balance-draft.tool.js';
import { fillSlotsTool } from './tools/fill-slots.tool.js';
import { getPlanTool } from './tools/get-plan.tool.js';
import { getRecipeTool } from './tools/get-recipe.tool.js';
import { consultNutritionSubagentTool } from './tools/nutrition-subagent.tool.js';
import { searchRecipesTool } from './tools/search-recipes.tool.js';
import { searchRestaurantDishesTool } from './tools/search-restaurant-dishes.tool.js';
import {
  requestWebSearchTool,
  webSearchTool,
} from './tools/web-search.tool.js';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';
import { AiFeature } from '../mongo/models.js';
import { AiUsageService } from '../subscriptions/ai-usage.service.js';
import { quotaStream } from '../subscriptions/quota-stream.js';
import { QuotaReachedException } from '../common/exceptions/quota-reached.exception.js';
import { RestaurantMenuService } from '../workspaces/restaurant-menu.service.js';

const MAX_STEPS = runtimeConfig.PLANNER_CHAT_MAX_STEPS;
const SEARCH_TIMEOUT_MS = runtimeConfig.AI_KNOWLEDGE_TOOL_TIMEOUT_MS;

export interface PlannerChatOptions {
  /** The user allowed web search in this chat. */
  allowWebSearch?: boolean;
}

/**
 * Web search is the user's choice: without consent the planner only gets the
 * tool that asks for it, so the prompt alone never decides whether it searches.
 */
function webTools(allowWebSearch: boolean): ToolSet {
  if (allowWebSearch) return { webSearch: webSearchTool() };
  return { requestWebSearch: requestWebSearchTool() };
}

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
    private readonly usage: AiUsageService,
    @Optional() private readonly history?: MealPlannerChatHistoryService,
    @Optional() private readonly restaurantMenu?: RestaurantMenuService,
  ) {}

  async stream(
    userId: string,
    messages: PlannerMessageDto[],
    abortSignal: AbortSignal,
    weekStart: string,
    requestId?: string,
    threadId?: string,
    { allowWebSearch = false }: PlannerChatOptions = {},
  ) {
    assertLastMessageFromUser(messages);
    if (threadId) {
      await this.history?.assertThreadAccess(userId, threadId);
    }
    const activeThreadId = threadId ?? randomUUID();
    abortSignal = AbortSignal.any([
      abortSignal,
      AbortSignal.timeout(runtimeConfig.AI_CHAT_TIMEOUT_MS),
    ]);
    const ticket = await this.usage.consume(userId, AiFeature.MEAL_PLAN_CHAT, {
      requestId,
      input: messages,
      prompt: messages.at(-1)?.text,
    });
    if (!ticket)
      throw new QuotaReachedException(
        'AI_QUOTA_EXCEEDED',
        'Your shared AI text allowance is exhausted',
      );
    try {
      await this.history?.recordUserTurn(
        userId,
        activeThreadId,
        messages,
        requestId,
      );
      const { choice: verdict } = await decide(
        this.moderator,
        conversationModerationState(messages),
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
        const assistantMessageId = randomUUID();
        await this.history?.recordAssistantMessage(userId, activeThreadId, {
          id: assistantMessageId,
          role: 'assistant',
          parts: [{ type: 'text', text: PLANNER_REFUSALS[verdict] }],
          metadata: { refused: true },
        });
        await this.usage.refund(ticket);
        return cannedReply(PLANNER_REFUSALS[verdict], assistantMessageId);
      }

      // A new conversation starts from the saved plans of every week. A card
      // the user dismisses later drops its week's draft through DELETE /draft.
      if (messages.length === 1) {
        await this.mealPlan.discardAllDrafts(userId);
      }
      const [restrictions, plan, draft, nutrition] = await Promise.all([
        this.dietary.find(userId),
        this.mealPlan.find(userId, weekStart),
        this.mealPlan.getDraft(userId, weekStart),
        Promise.resolve(this.dietary.findNutrition(userId)).then(
          (value) => value ?? null,
        ),
      ]);

      // A week that has fully passed is read-only, so tools default to this week.
      const toolWeek =
        plan.weekStart < plan.currentWeekStart
          ? plan.currentWeekStart
          : plan.weekStart;
       const avoidedTerms = [
        ...restrictions.ingredients.map(({ name }) => name),
        ...restrictions.groups.map(({ name }) => name),
        ...(restrictions.allergyNote ? [restrictions.allergyNote] : []),
      ];
      const agent = new ToolLoopAgent({
        model: this.model,
        instructions: plannerInstructions(
          restrictions,
          plan,
          draft,
          allowWebSearch,
          nutrition,
        ),
        maxOutputTokens: runtimeConfig.PLANNER_CHAT_MAX_OUTPUT_TOKENS,
        tools: {
          searchKnowledge: searchKnowledgeTool(this.knowledge),
          searchRecipes: searchRecipesTool(this.mealPlan, userId),
          getRecipe: getRecipeTool(this.mealPlan, userId),
          getPlan: getPlanTool(this.mealPlan, userId, toolWeek),
          fillSlots: fillSlotsTool(this.mealPlan, userId, toolWeek),
          autoBalanceDraft: autoBalanceDraftTool(
            this.mealPlan,
            userId,
            toolWeek,
          ),
          editDraft: editDraftTool(this.mealPlan, userId, toolWeek),
          consultNutritionSubagent: consultNutritionSubagentTool(
            this.model,
            this.mealPlan,
            this.knowledge,
            userId,
            nutrition,
            avoidedTerms,
          ),
          verifyMealPlanAllergies: verifyMealPlanAllergiesTool(
            this.model,
            this.mealPlan,
            userId,
            toolWeek,
            restrictions,
          ),
          ...(this.restaurantMenu
            ? {
                searchRestaurantDishes: searchRestaurantDishesTool(
                  this.restaurantMenu,
                  avoidedTerms,
                ),
              }
            : {}),
          ...webTools(allowWebSearch),
        },
        stopWhen: isStepCount(MAX_STEPS),
        prepareStep: ({ stepNumber }) =>
          stepNumber === MAX_STEPS - 1 ? { toolChoice: 'none' } : {},
      });

      const result = await agent.stream({
        messages: messages.map(({ role, text }) => ({ role, content: text })),
        abortSignal,
        timeout: {
          tools: {
            searchKnowledgeMs: SEARCH_TIMEOUT_MS,
            searchRestaurantDishesMs: SEARCH_TIMEOUT_MS,
          },
        },
        experimental_transform: replyFilter(),
      });
      const assistantMessageId = randomUUID();
      return quotaStream(
        toUIMessageStream({
          stream: result.stream,
          tools: agent.tools,
          sendSources: true,
          // Reasoning is excluded from the model, but some routes (web search) still stream it.
          sendReasoning: false,
          generateMessageId: () => assistantMessageId,
          onEnd: async ({ responseMessage }) => {
            try {
              await this.history?.recordAssistantMessage(
                userId,
                activeThreadId,
                responseMessage,
              );
            } catch (error) {
              this.logger.warn(
                `Failed to save assistant chat message: ${String(error)}`,
              );
            }
          },
          onError: (error) => {
            this.logger.error(
              `Meal planner stream failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return chatErrorCode(error);
          },
        }),
        this.usage,
        ticket,
      );
    } catch (error) {
      await this.usage.refund(ticket);
      throw error;
    }
  }
}
