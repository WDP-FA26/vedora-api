import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { runtimeConfig } from '../config/runtime-config.js';
import { InjectModel } from '@nestjs/ai';
import {
  convertToModelMessages,
  generateText,
  isStepCount,
  isTextUIPart,
  type LanguageModel,
  pruneMessages,
  type StopCondition,
  ToolLoopAgent,
  type ToolSet,
  toUIMessageStream,
  TypeValidationError,
  type UIMessage,
  validateUIMessages,
} from 'ai';
import { PromptCache } from '../ai/prompt-cache.js';
import { cannedReply } from '../ai/chat/canned-reply.js';
import { chatErrorCode } from '../ai/chat/errors.js';
import { replyFilter } from '../ai/chat/reply-filter.js';
import {
  conversationModerationState,
  type ModerationTurn,
} from '../ai/guardrails/conversation-state.js';
import { MODERATION_MODEL } from '../ai/guardrails/guardrail.js';
import { decide, type DecisionModel } from '../common/decision/decision.js';
import { NUTRITION_POLICY } from '../ai/guardrails/policies/nutrition.js';
import { searchKnowledgeTool } from '../knowledge/tools/search-knowledge.tool.js';
import { KnowledgeSearchService } from '../knowledge/retrieval/knowledge-search.service.js';
import { DietaryService } from '../recipes/dietary.service.js';
import { extractAllergyKeywords } from '../recipes/nutrition.js';
import type { PlannerToolOutputDto } from './dto/meal-plan.dto.js';
import type { MealPlanVoiceScreenDto } from './dto/meal-plan-voice.dto.js';
import { MealLogService } from './meal-log/meal-log.service.js';
import { MealPlanService } from './meal-plan.service.js';
import { currentMealWeek } from './meal-week.js';
import {
  MealPlannerChatHistoryService,
  type StoredChatMessage,
  validatePlannerToolOutput,
} from './meal-planner-chat-history.service.js';
import {
  plannerDynamicContext,
  plannerStaticInstructions,
  plannerVoiceInstructions,
  voiceScreenContext,
} from './meal-planner.prompt.js';
import { PLANNER_REFUSALS } from './meal-planner.refusals.js';
import { editPlanTool } from './tools/edit-plan.tool.js';
import { verifyMealPlanAllergiesTool } from './tools/allergy-verifier-subagent.tool.js';
import { askUserTool } from './tools/ask-user.tool.js';
import { updateMemoryTool } from './tools/dietary-memory.tool.js';
import { autoBalancePlanTool } from './tools/auto-balance-plan.tool.js';
import { fillSlotsTool } from './tools/fill-slots.tool.js';
import { getEatingLogTool } from './tools/get-eating-log.tool.js';
import { getPlanTool } from './tools/get-plan.tool.js';
import { getRecipeTool } from './tools/get-recipe.tool.js';
import { logMealTool } from './tools/log-meal.tool.js';
import { consultNutritionSubagentTool } from './tools/nutrition-subagent.tool.js';
import { searchRecipesTool } from './tools/search-recipes.tool.js';
import { searchRestaurantDishesTool } from './tools/search-restaurant-dishes.tool.js';
import { undoLastChangeTool } from './tools/undo-last-change.tool.js';
import { endCallTool } from './tools/end-call.tool.js';
import { updateBodyMetricsTool } from './tools/update-body-metrics.tool.js';
import {
  legacyVoiceScreenTools,
  setScreenTool,
} from './tools/voice-screen.tools.js';
import {
  requestWebSearchTool,
  webSearchTool,
} from './tools/web-search.tool.js';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { AiFeature } from '../mongo/models.js';
import { AiUsageService } from '../subscriptions/ai-usage.service.js';
import { quotaStream } from '../subscriptions/quota-stream.js';
import { QuotaReachedException } from '../common/exceptions/quota-reached.exception.js';
import { RestaurantMenuService } from '../workspaces/restaurant-menu.service.js';

const MAX_STEPS = runtimeConfig.PLANNER_CHAT_MAX_STEPS;
const SEARCH_TIMEOUT_MS = runtimeConfig.AI_KNOWLEDGE_TOOL_TIMEOUT_MS;
const VOICE_CHAT_TIMEOUT_MS = 60_000;
const VOICE_SUBAGENT_TIMEOUT_MS = 25_000;
const VOICE_CACHE_WARMUP_COOLDOWN_MS = 2 * 60 * 1000;
const VOICE_CACHE_WARMUP_TIMEOUT_MS = 10_000;
const VOICE_CACHE_WARMUP_MAX_ENTRIES = 1_000;

/** Added on the last step, when tools are off, so the turn ends with a handover instead of a cut. */
const LAST_STEP_NOTE = `

This is the final step of this turn, so you can no longer call tools. Briefly summarize in Vietnamese what has been completed and saved, state clearly what remains unfinished, and ask the user whether they want you to continue.`;

export interface PlannerChatOptions {
  /** The user allowed web search in this chat. */
  allowWebSearch?: boolean;
  /** Answer for a pending client-side `askUser` or `requestWebSearch` tool call. */
  toolOutput?: PlannerToolOutputDto;
  /**
   * The turn comes from the voice agent: short spoken replies, no `askUser`,
   * plus the screen tools, the diary/body-metrics writers and undo. Voice
   * turns keep web search off to reduce latency.
   */
  voice?: boolean;
  /** Voice only: what the page shows while the user speaks. */
  screen?: MealPlanVoiceScreenDto;
}

/** Tool states in which the AI SDK requires the call's `input`. */
const STATES_WITH_INPUT = new Set([
  'input-available',
  'output-available',
  'output-error',
]);

/**
 * Restores `input: {}` on tool calls made without arguments. Messages saved before
 * the schema kept empty objects lost it, and validation then dropped the whole
 * history for every later turn of the thread.
 */
function withToolInputs(message: StoredChatMessage): StoredChatMessage {
  const parts = message.parts.map((part) => {
    if (typeof part.type !== 'string' || !part.type.startsWith('tool-')) {
      return part;
    }
    if (part.input !== undefined) return part;
    if (typeof part.state !== 'string' || !STATES_WITH_INPUT.has(part.state)) {
      return part;
    }
    return { ...part, input: {} };
  });
  return { ...message, parts };
}

function stripPlannerTags(text: string): string {
  return text.replace(/<\/?(?:planner_context|system-reminder)\b[^>]*>?/gi, '');
}

const QUICK_WRITE_TOOLS = new Set([
  'logMeal',
  'updateBodyMetrics',
  'undoLastChange',
]);

function hasDoneFlag(output: unknown): boolean {
  return (
    typeof output === 'object' &&
    output !== null &&
    'done' in output &&
    output.done === true
  );
}

function isQuickSetScreenResult(output: unknown): boolean {
  return (
    hasDoneFlag(output) &&
    typeof output === 'object' &&
    output !== null &&
    'applied' in output &&
    output.applied === true
  );
}

function isQuickVoiceToolResult(toolName: string, output: unknown): boolean {
  if (toolName === 'endCall') return true;
  if (toolName === 'setScreen') return isQuickSetScreenResult(output);
  if (QUICK_WRITE_TOOLS.has(toolName)) return hasDoneFlag(output);
  return false;
}

/**
 * Ends a voice turn right after step 1 when it only ran `endCall` or quick
 * screen/write tools marked `done: true` (the frontend speaks the factual summary).
 */
const voiceQuickStop: StopCondition<ToolSet> = ({ steps }) => {
  const latest = steps[steps.length - 1];
  if (!latest || latest.toolResults.length === 0) return false;
  if (latest.toolResults.some((item) => item.toolName === 'endCall')) {
    return true;
  }
  return latest.toolResults.every((item) =>
    isQuickVoiceToolResult(item.toolName, item.output),
  );
};

/**
 * Web search is the user's choice: without consent the planner only gets the
 * tool that asks for it, so the prompt alone never decides whether it searches.
 */
function webTools(allowWebSearch: boolean): ToolSet {
  if (allowWebSearch) return { webSearch: webSearchTool() };
  return { requestWebSearch: requestWebSearchTool() };
}

function extractMessageText(message: StoredChatMessage): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      chunks.push(part.text);
    }
  }
  return chunks.join('\n');
}

function toModerationTurns(
  messages: readonly StoredChatMessage[],
): ModerationTurn[] {
  const turns: ModerationTurn[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const rawText = extractMessageText(message);
    const text = message.role === 'user' ? stripPlannerTags(rawText) : rawText;
    if (text.trim().length > 0) {
      turns.push({ role: message.role, text });
    }
  }
  return turns;
}

/** Strips planner tags the user typed, so they can't pose as server context. */
function stripUserPlannerTags(messages: readonly UIMessage[]): UIMessage[] {
  const prepared: UIMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user') {
      prepared.push(message);
      continue;
    }
    const sanitizedParts: UIMessage['parts'] = [];
    for (const part of message.parts) {
      if (isTextUIPart(part)) {
        sanitizedParts.push({ ...part, text: stripPlannerTags(part.text) });
      } else {
        sanitizedParts.push(part);
      }
    }
    prepared.push({ ...message, parts: sanitizedParts });
  }
  return prepared;
}

function safeConversionTools(tools: ToolSet): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    const toModelOutput = definition.toModelOutput;
    if (!toModelOutput) {
      wrapped[name] = definition;
      continue;
    }
    wrapped[name] = {
      ...definition,
      toModelOutput: async (args: {
        toolCallId: string;
        input: unknown;
        output: unknown;
      }) => {
        try {
          return await toModelOutput(args);
        } catch {
          const fallback: { type: 'text'; value: string } = {
            type: 'text',
            value: JSON.stringify(args.output ?? null),
          };
          return fallback;
        }
      },
    };
  }
  return wrapped;
}

@Injectable()
export class MealPlannerChatService {
  private readonly logger = new Logger(MealPlannerChatService.name);
  private readonly warmedVoiceSessions = new Map<string, number>();

  constructor(
    @Inject(MODERATION_MODEL)
    private readonly moderator: DecisionModel,
    @InjectModel() private readonly model: LanguageModel,
    private readonly mealPlan: MealPlanService,
    private readonly dietary: DietaryService,
    private readonly knowledge: KnowledgeSearchService,
    private readonly usage: AiUsageService,
    @Optional() private readonly history?: MealPlannerChatHistoryService,
    @Optional() private readonly restaurantMenu?: RestaurantMenuService,
    @Optional() private readonly mealLog?: MealLogService,
  ) {}

  /**
   * Builds the exact tool set for a planner turn (shared between live turns and
   * voice prompt-cache warm-up so the tool prefix matches byte-for-byte).
   */
  private buildAgentTools({
    userId,
    threadId,
    toolWeek,
    voice,
    allowWebSearch,
    screen,
    memory,
    nutrition,
    allergyLines,
    allergyKeywords,
    onAllergiesSaved,
  }: {
    userId: string;
    threadId: string;
    toolWeek: string;
    voice: boolean;
    allowWebSearch: boolean;
    screen?: MealPlanVoiceScreenDto;
    memory: { allergies: string[]; preferences: string[] };
    nutrition: Awaited<ReturnType<DietaryService['findNutrition']>> | null;
    allergyLines: string[];
    allergyKeywords: string[];
    onAllergiesSaved: (allergies: string[]) => void;
  }): ToolSet {
    const agentTools: ToolSet = {
      searchKnowledge: searchKnowledgeTool(this.knowledge),
      searchRecipes: searchRecipesTool(this.mealPlan, userId),
      getRecipe: getRecipeTool(this.mealPlan, userId),
      getPlan: getPlanTool(this.mealPlan, userId, toolWeek),
      fillSlots: fillSlotsTool(this.mealPlan, userId, toolWeek),
      autoBalancePlan: autoBalancePlanTool(this.mealPlan, userId, toolWeek),
      editPlan: editPlanTool(this.mealPlan, userId, toolWeek),
      askUser: askUserTool(),
      updateMemory: updateMemoryTool(this.dietary, userId, onAllergiesSaved),
      consultNutritionSubagent: consultNutritionSubagentTool(
        this.model,
        this.mealPlan,
        this.knowledge,
        userId,
        nutrition,
        allergyLines,
      ),
      verifyMealPlanAllergies: verifyMealPlanAllergiesTool(
        this.model,
        this.mealPlan,
        userId,
        toolWeek,
        memory,
      ),
      ...(this.restaurantMenu
        ? {
            searchRestaurantDishes: searchRestaurantDishesTool(
              this.restaurantMenu,
              allergyKeywords,
            ),
          }
        : {}),
      ...(this.mealLog
        ? {
            getEatingLog: getEatingLogTool(this.mealLog, userId, toolWeek),
          }
        : {}),
      ...(voice ? {} : webTools(allowWebSearch)),
    };
    if (voice) {
      // Nobody can tap an option mid-call, so choices are asked out loud.
      delete agentTools.askUser;
      Object.assign(
        agentTools,
        this.voiceTools(userId, threadId, toolWeek, screen),
      );
    }
    return agentTools;
  }

  /**
   * Fires a tiny no-tool call with the exact voice tools + system prompt while
   * the browser acquires the mic and GPT-Live greets the user, so the first
   * spoken turn hits a warm 1h prompt cache and sticky session route.
   */
  async warmVoiceCache(userId: string, threadId?: string): Promise<void> {
    const key = PromptCache.sessionId('vedora-planner', userId, threadId);
    const now = Date.now();
    const lastWarmed = this.warmedVoiceSessions.get(key);
    if (
      lastWarmed !== undefined &&
      now - lastWarmed < VOICE_CACHE_WARMUP_COOLDOWN_MS
    ) {
      return;
    }
    if (this.warmedVoiceSessions.size >= VOICE_CACHE_WARMUP_MAX_ENTRIES) {
      this.warmedVoiceSessions.clear();
    }
    this.warmedVoiceSessions.set(key, now);

    const tools = this.buildAgentTools({
      userId,
      threadId: threadId ?? 'warmup',
      toolWeek: currentMealWeek().weekStart,
      voice: true,
      allowWebSearch: false,
      memory: { allergies: [], preferences: [] },
      nutrition: null,
      allergyLines: [],
      allergyKeywords: [],
      onAllergiesSaved: () => undefined,
    });
    const { instructions, ...callOptions } = PromptCache.agent({
      session: 'vedora-planner',
      scope: [userId, threadId],
      instructions: plannerVoiceInstructions(),
      effort: 'medium',
      systemTtl: '1h',
    });

    try {
      await generateText({
        model: this.model,
        system: instructions,
        ...callOptions,
        tools,
        toolChoice: 'none',
        maxOutputTokens: 64,
        messages: [{ role: 'user', content: 'ping' }],
        abortSignal: AbortSignal.timeout(VOICE_CACHE_WARMUP_TIMEOUT_MS),
      });
    } catch (error) {
      this.warmedVoiceSessions.delete(key);
      this.logger.warn(
        `Voice prompt cache warm-up failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Tools only voice turns get. Text turns still know their definitions, so a
   * thread that mixed voice and text validates against either.
   */
  private voiceTools(
    userId: string,
    threadId: string,
    toolWeek: string,
    screen?: MealPlanVoiceScreenDto,
  ): ToolSet {
    return {
      setScreen: setScreenTool(
        this.mealPlan,
        this.dietary,
        userId,
        toolWeek,
        screen,
      ),
      endCall: endCallTool(),
      updateBodyMetrics: updateBodyMetricsTool(this.dietary, userId),
      ...(this.mealLog ? { logMeal: logMealTool(this.mealLog, userId) } : {}),
      ...(this.history
        ? { undoLastChange: undoLastChangeTool(this.history, userId, threadId) }
        : {}),
    };
  }

  /** The screen section of a voice turn's context, with the open recipe's catalog title. */
  private async screenContext(
    userId: string,
    screen: MealPlanVoiceScreenDto,
  ): Promise<string> {
    if (screen.panel !== 'recipe' || !screen.recipeId) {
      return voiceScreenContext(screen, null);
    }
    const recipe = await this.mealPlan.recipeInstructions(
      userId,
      screen.recipeId,
    );
    return voiceScreenContext(screen, recipe?.title ?? null);
  }

  /**
   * Validates the stored history against the current tools, as the AI SDK
   * persistence guide does. When it no longer matches (a removed tool, a
   * changed schema), the turn starts over from the user's latest message.
   */
  private async validateHistory(
    messages: readonly StoredChatMessage[],
    currentMessage: StoredChatMessage,
    tools: ToolSet,
  ): Promise<UIMessage[]> {
    try {
      return await validateUIMessages({
        messages: messages.map(withToolInputs),
        tools,
      });
    } catch (error) {
      if (!TypeValidationError.isInstance(error)) throw error;
      this.logger.warn(
        `Stored planner history no longer matches the tools; starting from the latest message: ${error.message}`,
      );
      return validateUIMessages({ messages: [currentMessage] });
    }
  }

  async stream(
    userId: string,
    message: string,
    abortSignal: AbortSignal,
    weekStart: string,
    requestId?: string,
    threadId?: string,
    {
      allowWebSearch = false,
      toolOutput,
      voice = false,
      screen,
    }: PlannerChatOptions = {},
  ) {
    const cleanUserText = stripPlannerTags(message);
    if (cleanUserText.trim().length === 0) {
      throw new InvalidInputException(
        'BAD_REQUEST',
        'Message must not be empty',
      );
    }
    if (toolOutput) {
      validatePlannerToolOutput(toolOutput);
    }
    if (threadId) {
      await this.history?.assertThreadAccess(userId, threadId);
    }
    const activeThreadId = threadId ?? randomUUID();
    const turnTimeoutMs = voice
      ? Math.min(runtimeConfig.AI_CHAT_TIMEOUT_MS, VOICE_CHAT_TIMEOUT_MS)
      : runtimeConfig.AI_CHAT_TIMEOUT_MS;
    abortSignal = AbortSignal.any([
      abortSignal,
      AbortSignal.timeout(turnTimeoutMs),
    ]);
    const ticket = await this.usage.consume(userId, AiFeature.MEAL_PLAN_CHAT, {
      requestId,
      input: {
        threadId: threadId ?? null,
        message,
        ...(toolOutput ? { toolOutput } : {}),
      },
      prompt: message,
    });
    if (!ticket)
      throw new QuotaReachedException(
        'AI_QUOTA_EXCEEDED',
        'Your shared AI text allowance is exhausted',
      );
    try {
      const userMessageId = requestId ?? randomUUID();
      const currentMessage: StoredChatMessage = {
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: cleanUserText }],
      };
      let pendingUserRecord: Promise<void> | undefined;
      const loadHistory = async (awaitUserWrite: boolean) => {
        if (toolOutput) {
          await this.history?.recordToolOutput(
            userId,
            activeThreadId,
            toolOutput,
          );
        }
        const recordUser = this.history?.recordUserMessage(
          userId,
          activeThreadId,
          message,
          userMessageId,
        );
        const loadMessages = this.history?.loadContextMessages(
          userId,
          activeThreadId,
          runtimeConfig.PLANNER_CHAT_MAX_MESSAGES,
        );
        let loaded: StoredChatMessage[] | undefined;
        if (awaitUserWrite) {
          [, loaded] = await Promise.all([recordUser, loadMessages]);
        } else {
          // Voice turns let the user message write finish in the background
          // while reads complete and the model starts; `onEnd` awaits it before
          // saving the assistant reply so thread order stays intact.
          pendingUserRecord = recordUser?.catch((error: unknown) => {
            this.logger.warn(
              `Failed to save user chat message: ${String(error)}`,
            );
          });
          loaded = await loadMessages;
        }
        const existing = loaded ?? [];
        return existing.some((item) => item.id === userMessageId)
          ? [...existing]
          : [...existing, currentMessage];
      };
      const loadContext = () =>
        Promise.all([
          this.dietary.findPlannerContext(userId),
          this.mealPlan.findForPrompt(userId, weekStart),
          voice && screen
            ? this.screenContext(userId, screen)
            : Promise.resolve(null),
        ]);

      let storedMessages: StoredChatMessage[];
      let context: Awaited<ReturnType<typeof loadContext>>;
      if (voice) {
        // Voice turns skip the extra moderation round-trip, so context queries
        // can run alongside history loading without adding latency.
        [storedMessages, context] = await Promise.all([
          loadHistory(false),
          loadContext(),
        ]);
      } else {
        storedMessages = await loadHistory(true);
        const { choice: verdict } = await decide(
          this.moderator,
          conversationModerationState(toModerationTurns(storedMessages)),
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
        context = await loadContext();
      }

      const [{ memory, nutrition }, plan, screenText] = context;

      // A week that has fully passed is read-only, so tools default to this week.
      const toolWeek =
        plan.weekStart < plan.currentWeekStart
          ? plan.currentWeekStart
          : plan.weekStart;
      // Restaurant dishes are matched on allergen keywords; the nutrition
      // subagent reads the allergy lines themselves.
      const allergyKeywords = extractAllergyKeywords(
        memory.allergies.join('\n'),
      );
      const allergyLines = [...memory.allergies];
      // An allergy the user adds mid-chat applies to the rest of this turn too:
      // the allergy check and the restaurant/consult filters read these arrays.
      const onAllergiesSaved = (allergies: string[]) => {
        memory.allergies = allergies;
        allergyLines.splice(0, allergyLines.length, ...allergies);
        allergyKeywords.splice(
          0,
          allergyKeywords.length,
          ...extractAllergyKeywords(allergies.join('\n')),
        );
      };
      const plannerContext = plannerDynamicContext(memory, plan, nutrition);
      const dynamicContext = screenText
        ? `${plannerContext}\n\n${screenText}`
        : plannerContext;
      const agentTools = this.buildAgentTools({
        userId,
        threadId: activeThreadId,
        toolWeek,
        voice,
        allowWebSearch,
        screen,
        memory,
        nutrition,
        allergyLines,
        allergyKeywords,
        onAllergiesSaved,
      });
      const agent = new ToolLoopAgent({
        model: this.model,
        ...PromptCache.agent({
          session: 'vedora-planner',
          scope: [userId, activeThreadId],
          instructions: voice
            ? plannerVoiceInstructions()
            : plannerStaticInstructions(allowWebSearch),
          // Long prompt, many tools, up to 20 steps: at low effort Haiku 5.5
          // is more likely to skip a lookup or a check.
          effort: 'medium',
          // Voice turns are bounded by a 5-minute call with pauses; 1h keeps the
          // prefix hot across long thinking/speaking gaps.
          systemTtl: voice ? '1h' : '5m',
        }),
        maxOutputTokens: runtimeConfig.PLANNER_CHAT_MAX_OUTPUT_TOKENS,
        tools: agentTools,
        stopWhen: voice
          ? [isStepCount(MAX_STEPS), voiceQuickStop]
          : isStepCount(MAX_STEPS),
        prepareStep: PromptCache.finalStepGuard(MAX_STEPS, LAST_STEP_NOTE),
      });

      const conversionTools = safeConversionTools({
        ...legacyVoiceScreenTools(
          this.mealPlan,
          this.dietary,
          userId,
          toolWeek,
        ),
        ...this.voiceTools(userId, activeThreadId, toolWeek, screen),
        ...agentTools,
        askUser: askUserTool(),
        requestWebSearch: requestWebSearchTool(),
        webSearch: webSearchTool(),
      });
      const validatedMessages = await this.validateHistory(
        storedMessages,
        currentMessage,
        conversionTools,
      );
      // A client-side tool call the user never answered (`askUser`,
      // `requestWebSearch`) has no output; `ignoreIncompleteToolCalls` drops it.
      const rawModelMessages = await convertToModelMessages(
        stripUserPlannerTags(validatedMessages),
        {
          tools: conversionTools,
          ignoreIncompleteToolCalls: true,
        },
      );
      const prunedMessages = pruneMessages({
        messages: rawModelMessages,
        reasoning: 'all',
        toolCalls: [
          {
            type: 'before-last-message',
            tools: ['searchKnowledge', 'getPlan', 'getEatingLog'],
          },
          {
            type: 'before-last-12-messages',
          },
        ],
        emptyMessages: 'remove',
      });

      const result = await agent.stream({
        messages: PromptCache.withUserContext(
          prunedMessages,
          `<planner_context>\n${dynamicContext}\n</planner_context>`,
        ),
        abortSignal,
        timeout: {
          tools: {
            searchKnowledgeMs: SEARCH_TIMEOUT_MS,
            searchRestaurantDishesMs: SEARCH_TIMEOUT_MS,
            ...(voice
              ? {
                  consultNutritionSubagentMs: VOICE_SUBAGENT_TIMEOUT_MS,
                  verifyMealPlanAllergiesMs: VOICE_SUBAGENT_TIMEOUT_MS,
                }
              : {}),
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
              await pendingUserRecord;
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
