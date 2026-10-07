import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  createUIMessageStream,
  isStepCount,
  type LanguageModel,
  ToolLoopAgent,
  toUIMessageStream,
} from 'ai';
import { KnowledgeSearchService } from '../knowledge/retrieval/knowledge-search.service';
import { chatErrorCode } from '../nutrition-chat/nutrition-chat.service';
import { replyFilter } from '../nutrition-chat/reply-filter';
import { searchKnowledgeTool } from '../nutrition-chat/tools/search-knowledge.tool';
import { DietaryService } from '../recipes/dietary.service';
import type { PlannerMessageDto } from './dto/meal-plan.dto';
import { MealPlanService } from './meal-plan.service';
import { plannerInstructions } from './meal-planner.prompt';
import { moderatePlannerMessage, PLANNER_REFUSALS } from './planner-moderation';
import { proposeMealPlanTool } from './tools/propose-meal-plan.tool';
import { searchRecipesTool } from './tools/search-recipes.tool';

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
    const openRouter = createOpenRouter({
      apiKey: configService.getOrThrow<string>('OPENROUTER_API_KEY'),
    });
    this.moderationModel = openRouter(
      configService.get<string>(
        'OPENROUTER_MODERATION_MODEL',
        'openai/gpt-oss-safeguard-20b',
      ),
      { reasoning: { effort: 'low', exclude: true } },
    );
    this.model = openRouter(
      configService.get<string>('OPENROUTER_MODEL', 'openrouter/auto'),
      {
        reasoning: {
          effort: configService.get('OPENROUTER_REASONING_EFFORT', 'low'),
          exclude: true,
        },
      },
    );
  }

  async stream(
    userId: string,
    messages: PlannerMessageDto[],
    abortSignal: AbortSignal,
  ) {
    const verdict = await moderatePlannerMessage(
      this.moderationModel,
      messages.at(-1)?.text ?? '',
      abortSignal,
    ).catch((error: unknown) => {
      if (abortSignal.aborted) throw error;
      this.logger.error(`Moderation failed: ${String(error)}`);
      throw new ServiceUnavailableException('Moderation is unavailable');
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

function cannedReply(text: string) {
  return createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: 'start', messageMetadata: { refused: true } });
      writer.write({ type: 'text-start', id: 'reply' });
      writer.write({ type: 'text-delta', id: 'reply', delta: text });
      writer.write({ type: 'text-end', id: 'reply' });
      writer.write({ type: 'finish', finishReason: 'stop' });
    },
  });
}
