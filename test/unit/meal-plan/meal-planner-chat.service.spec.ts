import { runtimeConfig } from '@src/config/runtime-config.js';
import {
  FakeEmbeddingModel,
  FakeModel,
  providerError,
} from '@nestjs/ai/testing';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { APICallError, simulateReadableStream, type UIMessageChunk } from 'ai';
import { convertReadableStreamToArray, MockLanguageModelV4 } from 'ai/test';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { AiModule } from '@src/ai/ai.module.js';
import { DEFAULT_OPENROUTER_MODERATION_PROVIDER_ORDER } from '@src/ai/providers/provider-registry.js';
import { providerOrderFrom } from '@src/ai/providers/provider-shared.js';
import { NUTRITION_POLICY } from '@src/ai/guardrails/policies/nutrition.js';
import { AiCostTransportService } from '@src/ai/telemetry/ai-cost-transport.service.js';
import { FeatureUnavailableException } from '@src/common/exceptions/feature-unavailable.exception.js';
import { QuotaReachedException } from '@src/common/exceptions/quota-reached.exception.js';
import { KnowledgeSearchService } from '@src/knowledge/retrieval/knowledge-search.service.js';
import { MealPlanService } from '@src/meal-plan/meal-plan.service.js';
import { MealPlannerChatHistoryService } from '@src/meal-plan/meal-planner-chat-history.service.js';
import { MealPlannerChatService } from '@src/meal-plan/meal-planner-chat.service.js';
import { ModerationSettingsService } from '@src/moderation/moderation-settings.service.js';
import { AiFeature, MealSection, Weekday } from '@src/mongo/models.js';
import { DietaryService } from '@src/recipes/dietary.service.js';
import {
  AiUsageService,
  type UsageTicket,
} from '@src/subscriptions/ai-usage.service.js';
import { PLANNER_MODEL_DECLINED_REPLY } from '@src/meal-plan/meal-planner.refusals.js';
import { RestaurantMenuService } from '@src/workspaces/restaurant-menu.service.js';

type StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV4['doStream']>
  >['stream'] extends ReadableStream<infer Part>
    ? Part
    : never;

const usage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
};

const textChunks: StreamPart[] = [
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'Mình đã gợi ý thực đơn.' },
  { type: 'text-end', id: 'text-1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
];

const searchRecipesChunk: StreamPart[] = [
  {
    type: 'tool-call',
    toolCallId: 'call-search',
    toolName: 'searchRecipes',
    input: JSON.stringify({ query: 'đậu hũ' }),
  },
  {
    type: 'finish',
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage,
  },
];

let steps: StreamPart[][] = [];
let verdict = 'allow';
let rateLimitModeration = false;
let streamError: Error | null = null;

const model = new MockLanguageModelV4({
  doGenerate: () =>
    Promise.resolve({
      content: [{ type: 'text', text: 'OK' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    }),
  doStream: () =>
    Promise.resolve({
      stream: simulateReadableStream({
        initialDelayInMs: null,
        chunkDelayInMs: null,
        chunks: streamError
          ? [{ type: 'error', error: streamError }]
          : (steps.shift() ?? textChunks),
      }),
    }),
});

const MODERATION_MODEL_ID = 'anthropic/claude-haiku-5.5';

const moderator = new FakeModel(() =>
  rateLimitModeration
    ? providerError(429, { retryAfter: 0 })
    : { object: { choice: verdict } },
);

const languageModel = Object.assign(
  vi.fn<
    (modelId: string, settings: { reasoning: object }) => MockLanguageModelV4
  >((modelId) => (modelId === MODERATION_MODEL_ID ? moderator : model)),
  { textEmbeddingModel: () => new FakeEmbeddingModel() },
);
const createOpenRouter = vi.fn<
  (settings: { apiKey: string }) => typeof languageModel
>(() => languageModel);

vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: (settings: { apiKey: string }) =>
    createOpenRouter(settings),
}));

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const WEEK = '2026-11-16';
const TICKET: UsageTicket = { id: 'ticket-1', token: 'tok-1', hash: 'hash-1' };

const replyText = (chunks: UIMessageChunk[]) =>
  chunks
    .map((chunk) => (chunk.type === 'text-delta' ? chunk.delta : ''))
    .join('');

describe('MealPlannerChatService', () => {
  let mealPlan: DeepMockProxy<MealPlanService>;
  let dietary: DeepMockProxy<DietaryService>;
  let knowledge: DeepMockProxy<KnowledgeSearchService>;
  let aiUsage: DeepMockProxy<AiUsageService>;
  let history: DeepMockProxy<MealPlannerChatHistoryService>;
  let restaurantMenu: DeepMockProxy<RestaurantMenuService>;

  beforeEach(() => {
    mealPlan = mockDeep<MealPlanService>();
    dietary = mockDeep<DietaryService>();
    knowledge = mockDeep<KnowledgeSearchService>();
    aiUsage = mockDeep<AiUsageService>();
    history = mockDeep<MealPlannerChatHistoryService>();
    restaurantMenu = mockDeep<RestaurantMenuService>();
    restaurantMenu.suggestForPlanner.mockResolvedValue([]);

    aiUsage.consume.mockResolvedValue(TICKET);
    aiUsage.complete.mockResolvedValue(undefined);
    aiUsage.refund.mockResolvedValue(undefined);
    history.assertThreadAccess.mockResolvedValue(undefined);
    history.recordToolOutput.mockResolvedValue(undefined);
    history.recordUserMessage.mockResolvedValue(undefined);
    history.loadContextMessages.mockResolvedValue([]);
    history.recordAssistantMessage.mockResolvedValue(undefined);

    const emptyNutrition = {
      heightCm: null,
      weightKg: null,
      targetWeightKg: null,
      birthYear: null,
      biologicalSex: null,
      activityLevel: null,
      nutritionGoal: null,
      bmi: null,
      bmiCategory: null,
      suggestedGoal: null,
      effectiveGoal: null,
      idealWeightMinKg: null,
      idealWeightMaxKg: null,
      bmr: null,
      tdee: null,
      dailyCalorieTarget: null,
      dailyCalorieMin: null,
      dailyCalorieMax: null,
      safetyNote: null,
      history: [],
    };
    dietary.findPlannerContext.mockResolvedValue({
      memory: { allergies: [], preferences: [] },
      nutrition: emptyNutrition,
    });
    mealPlan.findForPrompt.mockResolvedValue({
      weekStart: WEEK,
      currentWeekStart: WEEK,
      today: WEEK,
      maxWeekStart: '2026-12-14',
      minWeekStart: WEEK,
      editable: true,
      days: Object.values(Weekday).map((day) => ({
        day,
        date: WEEK,
        editable: true,
        sections: Object.values(MealSection).map((section) => ({
          section,
          recipes: [],
        })),
      })),
      problems: [],
    });

    createOpenRouter.mockClear();
    languageModel.mockClear();
    model.doStreamCalls.length = 0;
    moderator.calls.length = 0;
    steps = [];
    verdict = 'allow';
    rateLimitModeration = false;
    streamError = null;
  });

  async function createService() {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              OPENROUTER_API_KEY: 'key',
              AI_CHAT_MODEL: 'test/model',
            }),
          ],
        }),
        AiModule,
      ],
      providers: [
        MealPlannerChatService,
        { provide: MealPlanService, useValue: mealPlan },
        { provide: DietaryService, useValue: dietary },
        { provide: KnowledgeSearchService, useValue: knowledge },
        { provide: AiUsageService, useValue: aiUsage },
        { provide: MealPlannerChatHistoryService, useValue: history },
        { provide: RestaurantMenuService, useValue: restaurantMenu },
      ],
    })
      .overrideProvider(AiCostTransportService)
      .useValue({ forModel: () => fetch })
      .overrideProvider(ModerationSettingsService)
      .useValue({})
      .compile();

    return moduleRef.get(MealPlannerChatService);
  }

  it('throws QuotaReachedException when AI usage allowance is exhausted', async () => {
    aiUsage.consume.mockResolvedValue(null);
    const service = await createService();

    await expect(
      service.stream(
        USER_ID,
        'Lên thực đơn',
        new AbortController().signal,
        WEEK,
        'req-1',
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof QuotaReachedException &&
        err.code === 'AI_QUOTA_EXCEEDED',
    );
    expect(aiUsage.consume).toHaveBeenCalledWith(
      USER_ID,
      AiFeature.MEAL_PLAN_CHAT,
      {
        requestId: 'req-1',
        input: { threadId: null, message: 'Lên thực đơn' },
        prompt: 'Lên thực đơn',
      },
    );
    expect(moderator.calls).toHaveLength(0);
  });

  it('refunds the ticket and returns canned refusal when moderation flags the message', async () => {
    verdict = 'off_topic';
    const service = await createService();

    const chunks = await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Viết code JS',
        new AbortController().signal,
        WEEK,
      ),
    );

    expect(aiUsage.refund).toHaveBeenCalledWith(TICKET);
    expect(aiUsage.complete).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(0);
    expect(replyText(chunks)).toContain('chỉ giúp lên thực đơn');
  });

  it('refunds the ticket and throws 503 when moderation fails', async () => {
    rateLimitModeration = true;
    const service = await createService();

    await expect(
      service.stream(
        USER_ID,
        'Lên thực đơn',
        new AbortController().signal,
        WEEK,
      ),
    ).rejects.toThrow(FeatureUnavailableException);
    expect(aiUsage.refund).toHaveBeenCalledWith(TICKET);
  });

  it('refunds the ticket and rethrows when aborted before moderation completes', async () => {
    const abort = new AbortController();
    abort.abort(new Error('client closed'));
    const service = await createService();

    await expect(
      service.stream(USER_ID, 'Lên thực đơn', abort.signal, WEEK),
    ).rejects.toThrow('client closed');
    expect(aiUsage.refund).toHaveBeenCalledWith(TICKET);
  });

  it('loads user profile + meal plan, streams with the planner tools, and completes the ticket', async () => {
    const service = await createService();

    const chunks = await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Lên thực đơn ngày thứ Hai',
        new AbortController().signal,
        WEEK,
      ),
    );

    expect(languageModel).toHaveBeenCalledWith(MODERATION_MODEL_ID, {
      reasoning: { effort: 'low', exclude: true },
      provider: {
        order: providerOrderFrom(DEFAULT_OPENROUTER_MODERATION_PROVIDER_ORDER),
        allow_fallbacks: true,
      },
    });
    expect(moderator.lastCall?.instructions).toContain(
      NUTRITION_POLICY.instructions,
    );
    expect(moderator.lastCall?.lastUserMessage).toBe(
      'Message:\n<message>Lên thực đơn ngày thứ Hai</message>',
    );
    expect(dietary.findPlannerContext).toHaveBeenCalledWith(USER_ID);
    expect(mealPlan.findForPrompt).toHaveBeenCalledWith(USER_ID, WEEK);
    expect(replyText(chunks)).toBe('Mình đã gợi ý thực đơn.');
    expect(model.doStreamCalls[0].tools?.map((t) => t.name)).toEqual([
      'searchKnowledge',
      'searchRecipes',
      'getRecipe',
      'getPlan',
      'fillSlots',
      'autoBalancePlan',
      'editPlan',
      'askUser',
      'updateMemory',
      'consultNutritionSubagent',
      'verifyMealPlanAllergies',
      'searchRestaurantDishes',
      'requestWebSearch',
    ]);
    const [system, userMsg] = model.doStreamCalls[0].prompt;
    expect(system).toMatchObject({ role: 'system' });
    // The planner is session-scoped: its system prefix uses the 5m cache, not 1h.
    expect(system.providerOptions?.openrouter?.cacheControl).toEqual({
      type: 'ephemeral',
    });
    expect(JSON.stringify(system.content)).not.toContain('Hôm nay là');
    expect(JSON.stringify(userMsg)).toContain('<planner_context>');
    expect(model.doStreamCalls[0].providerOptions?.openrouter).toMatchObject({
      cacheControl: { type: 'ephemeral' },
    });
    const plannerOr = JSON.stringify(
      model.doStreamCalls[0].providerOptions?.openrouter,
    );
    expect(plannerOr).toMatch(/"session_id":"vedora-planner-[a-f0-9]{24}"/);
    expect(plannerOr).not.toContain(USER_ID);
    expect(aiUsage.complete).toHaveBeenCalledWith(TICKET);
    expect(aiUsage.refund).not.toHaveBeenCalled();
  });

  it('tells the user why when the model declines the request', async () => {
    steps = [
      [
        {
          type: 'finish',
          finishReason: { unified: 'content-filter', raw: 'refusal' },
          usage,
        },
      ],
    ];
    const service = await createService();

    const chunks = await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Lên thực đơn ngày thứ Hai',
        new AbortController().signal,
        WEEK,
      ),
    );

    expect(replyText(chunks)).toBe(PLANNER_MODEL_DECLINED_REPLY);
  });

  it('only asks for web search until the user allows it', async () => {
    const service = await createService();

    await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Tempeh mua ở đâu?',
        new AbortController().signal,
        WEEK,
      ),
    );
    const tools = model.doStreamCalls[0].tools ?? [];
    expect(tools.some((t) => t.type === 'provider')).toBe(false);
    const [system] = model.doStreamCalls[0].prompt;
    expect(system.role === 'system' && system.content).toContain(
      'the user has not yet granted permission to search the web',
    );
  });

  it('adds the OpenRouter web search server tool once the user allows it', async () => {
    const service = await createService();

    await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Đồng ý, bạn cứ tìm trên web.',
        new AbortController().signal,
        WEEK,
        undefined,
        undefined,
        { allowWebSearch: true },
      ),
    );
    const tools = model.doStreamCalls[0].tools ?? [];
    expect(tools.map((t) => t.name)).not.toContain('requestWebSearch');
    expect(tools).toContainEqual(
      expect.objectContaining({
        type: 'provider',
        id: 'openrouter.web_search',
        args: {
          parameters: {
            engine: 'parallel',
            mode: 'fast',
            search_context_size: 'medium',
            max_results: 5,
            max_total_results: 10,
            max_uses: 4,
          },
        },
      }),
    );
    const [system] = model.doStreamCalls[0].prompt;
    expect(system.role === 'system' && system.content).toContain(
      'you are allowed to search the web (webSearch)',
    );
  });

  it('swaps the button tools for the screen tools in a voice turn', async () => {
    const service = await createService();

    await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Cho mình xem chỉ số BMI',
        new AbortController().signal,
        WEEK,
        undefined,
        undefined,
        { voice: true },
      ),
    );
    const names = (model.doStreamCalls[0].tools ?? []).map((t) => t.name);
    expect(names).not.toContain('askUser');
    expect(names).not.toContain('requestWebSearch');
    expect(names).not.toContain('webSearch');
    expect(names).toEqual(
      expect.arrayContaining([
        'searchRecipes',
        'fillSlots',
        'setScreen',
        'endCall',
        'updateBodyMetrics',
        'undoLastChange',
      ]),
    );
    const [system] = model.doStreamCalls[0].prompt;
    expect(system.role === 'system' && system.content).toContain('Voice mode');
  });

  it('stops after step 1 in voice mode for endCall and setScreen(done: true)', async () => {
    steps = [
      [
        {
          type: 'tool-call',
          toolCallId: 'call-end',
          toolName: 'endCall',
          input: '{}',
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage,
        },
      ],
    ];
    const service = await createService();

    await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Tạm biệt nhé',
        new AbortController().signal,
        WEEK,
        undefined,
        undefined,
        { voice: true },
      ),
    );
    expect(model.doStreamCalls).toHaveLength(1);

    model.doStreamCalls.length = 0;
    steps = [
      [
        {
          type: 'tool-call',
          toolCallId: 'call-screen',
          toolName: 'setScreen',
          input: JSON.stringify({ view: 'calendar', done: true }),
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage,
        },
      ],
    ];

    await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Đóng lại giúp mình',
        new AbortController().signal,
        WEEK,
        undefined,
        undefined,
        { voice: true },
      ),
    );
    expect(model.doStreamCalls).toHaveLength(1);

    model.doStreamCalls.length = 0;
    dietary.saveNutrition.mockResolvedValue({
      heightCm: 165,
      weightKg: 60,
      targetWeightKg: null,
      birthYear: null,
      biologicalSex: null,
      activityLevel: null,
      nutritionGoal: null,
      bmi: 22,
      bmiCategory: null,
      suggestedGoal: null,
      effectiveGoal: null,
      idealWeightMinKg: null,
      idealWeightMaxKg: null,
      bmr: null,
      tdee: null,
      dailyCalorieTarget: 1800,
      dailyCalorieMin: null,
      dailyCalorieMax: null,
      safetyNote: null,
      history: [],
    });
    steps = [
      [
        {
          type: 'tool-call',
          toolCallId: 'call-metrics',
          toolName: 'updateBodyMetrics',
          input: JSON.stringify({ weightKg: 60, done: true }),
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage,
        },
      ],
    ];

    await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Cân nặng mới của mình là 60 ký',
        new AbortController().signal,
        WEEK,
        undefined,
        undefined,
        { voice: true },
      ),
    );
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('skips the moderation decision check in voice mode', async () => {
    rateLimitModeration = true;
    const service = await createService();

    const chunks = await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Đổi bữa tối sang đậu hũ sốt cà',
        new AbortController().signal,
        WEEK,
        undefined,
        undefined,
        { voice: true },
      ),
    );
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('warms the 1h voice prompt cache once per cooldown window with no tool execution', async () => {
    model.doGenerateCalls.length = 0;
    const service = await createService();

    await service.warmVoiceCache(USER_ID, 'thread-warm');
    await service.warmVoiceCache(USER_ID, 'thread-warm');

    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0];
    expect(call.toolChoice).toEqual({ type: 'none' });
    const [system] = call.prompt;
    expect(system).toMatchObject({ role: 'system' });
    expect(system.providerOptions?.openrouter?.cacheControl).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    expect(call.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['searchRecipes', 'setScreen', 'endCall']),
    );
  });

  it('loads voice context concurrently with history recording', async () => {
    let releaseRecord!: () => void;
    history.recordUserMessage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRecord = resolve;
        }),
    );
    mealPlan.recipeInstructions.mockResolvedValue(null);

    const service = await createService();
    const pendingStream = service.stream(
      USER_ID,
      'Mở bước tiếp theo của món này',
      new AbortController().signal,
      WEEK,
      undefined,
      undefined,
      {
        voice: true,
        screen: { weekStart: WEEK, panel: 'recipe', recipeId: 'recipe-1' },
      },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(history.loadContextMessages).toHaveBeenCalledWith(
      USER_ID,
      expect.any(String),
      expect.any(Number),
    );
    expect(dietary.findPlannerContext).toHaveBeenCalledWith(USER_ID);
    expect(mealPlan.findForPrompt).toHaveBeenCalledWith(USER_ID, WEEK);
    expect(mealPlan.recipeInstructions).toHaveBeenCalledWith(
      USER_ID,
      'recipe-1',
    );

    releaseRecord();
    await convertReadableStreamToArray(await pendingStream);
  });

  it('forwards web citations to the client as source parts', async () => {
    steps = [
      [
        {
          type: 'source',
          sourceType: 'url',
          id: 'https://example.com/tempeh',
          url: 'https://example.com/tempeh',
          title: 'Tempeh',
        },
        ...textChunks,
      ],
    ];
    const service = await createService();

    const chunks = await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Tempeh mua ở đâu?',
        new AbortController().signal,
        WEEK,
        undefined,
        undefined,
        { allowWebSearch: true },
      ),
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'source-url',
        url: 'https://example.com/tempeh',
        title: 'Tempeh',
      }),
    );
  });

  it('refunds the ticket when downstream setup throws after moderation', async () => {
    dietary.findPlannerContext.mockRejectedValueOnce(new Error('DB down'));
    const service = await createService();

    await expect(
      service.stream(
        USER_ID,
        'Lên thực đơn',
        new AbortController().signal,
        WEEK,
      ),
    ).rejects.toThrow('DB down');
    expect(aiUsage.refund).toHaveBeenCalledWith(TICKET);
  });

  it('forces an answer on the final step (MAX_STEPS - 1)', async () => {
    const maxSteps = runtimeConfig.PLANNER_CHAT_MAX_STEPS;
    steps = Array.from({ length: maxSteps - 1 }, () => searchRecipesChunk);
    mealPlan.suggestions.mockResolvedValue([]);
    const service = await createService();

    await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Gợi ý món đậu hũ',
        new AbortController().signal,
        WEEK,
      ),
    );

    expect(mealPlan.suggestions).toHaveBeenCalledTimes(maxSteps - 1);
    expect(model.doStreamCalls).toHaveLength(maxSteps);
    const lastCall = model.doStreamCalls[maxSteps - 1];
    expect(lastCall.toolChoice).toEqual({ type: 'none' });
    expect(lastCall.prompt[0]).toEqual(model.doStreamCalls[0].prompt[0]);
    expect(JSON.stringify(lastCall.prompt)).toContain('final step of this turn');
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain(
      'final step of this turn',
    );
  });

  it('refunds the ticket and emits error code when the model stream errors', async () => {
    streamError = new APICallError({
      message: 'Rate limited',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: {},
      responseBody: '',
      isRetryable: false,
      data: undefined,
    });
    const service = await createService();

    const chunks = await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Lên thực đơn',
        new AbortController().signal,
        WEEK,
      ),
    );

    expect(chunks.find((c) => c.type === 'error')).toEqual({
      type: 'error',
      errorText: 'RATE_LIMITED',
    });
    expect(aiUsage.refund).toHaveBeenCalledWith(TICKET);
  });

  it('rejects empty messages and invalid tool outputs before consuming quota', async () => {
    const service = await createService();

    await expect(
      service.stream(
        USER_ID,
        '<planner_context></planner_context>   ',
        new AbortController().signal,
        WEEK,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'BAD_REQUEST' });

    await expect(
      service.stream(
        USER_ID,
        'Chọn món 1',
        new AbortController().signal,
        WEEK,
        undefined,
        'thread-1',
        {
          toolOutput: {
            tool: 'askUser',
            toolCallId: 'call-1',
            output: { answer: '' },
          },
        },
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'BAD_REQUEST' });
    expect(aiUsage.consume).not.toHaveBeenCalled();
  });

  it('moderates full multi-turn context loaded from history and converts/prunes tool history', async () => {
    const service = await createService();
    const threadId = 'thread-history-1';
    history.loadContextMessages.mockResolvedValue([
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'Bữa sáng ăn gì?' }],
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-searchKnowledge',
            toolCallId: 'call-k1',
            state: 'output-available',
            input: { query: 'oatmeal protein' },
            output: {
              status: 'ok',
              hits: [{ title: 'Nutrition Guide', page: 1, text: 'Oats info' }],
            },
          },
          {
            type: 'tool-getPlan',
            toolCallId: 'call-plan-1',
            state: 'output-available',
            input: {},
            output: {
              plan: {
                weekStart: WEEK,
                days: [],
              },
            },
          },
          {
            type: 'tool-searchRecipes',
            toolCallId: 'call-r1',
            state: 'output-available',
            input: { query: 'yến mạch' },
            output: [
              {
                id: 'rec-1',
                title: 'Cháo yến mạch',
                tag: null,
                minutes: 15,
                caloriesPerServing: 280,
                nutritionPillars: [],
                ingredients: ['yến mạch'],
                description: null,
                avoidedIngredients: [],
              },
            ],
          },
          {
            type: 'text',
            text: 'Bạn muốn chọn món nào?',
          },
          {
            type: 'tool-askUser',
            toolCallId: 'call-ask-1',
            state: 'input-available',
            input: {
              question: 'Chọn món?',
              options: ['Cháo yến mạch (~280 kcal)', 'Bún riêu chay'],
            },
          },
        ],
      },
      {
        id: 'u2',
        role: 'user',
        parts: [{ type: 'text', text: 'Chọn Cháo yến mạch' }],
      },
    ]);

    await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Chọn Cháo yến mạch',
        new AbortController().signal,
        WEEK,
        'u2',
        threadId,
      ),
    );

    expect(moderator.lastCall?.lastUserMessage).toBe(
      [
        'Conversation, oldest turn first:',
        '<conversation>',
        '<turn role="user">Bữa sáng ăn gì?</turn>',
        '<turn role="assistant">Bạn muốn chọn món nào?</turn>',
        '<turn role="user">Chọn Cháo yến mạch</turn>',
        '</conversation>',
      ].join('\n'),
    );

    const promptJson = JSON.stringify(model.doStreamCalls[0].prompt);
    expect(promptJson).toContain('Cháo yến mạch');
    // Unanswered client-side tool calls are dropped (ignoreIncompleteToolCalls).
    expect(promptJson).not.toContain('call-ask-1');
    expect(promptJson).not.toContain('call-k1');
    expect(promptJson).not.toContain('call-plan-1');
  });

  it('keeps an answered askUser call in the model context', async () => {
    const service = await createService();
    history.loadContextMessages.mockResolvedValue([
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'Bữa sáng ăn gì?' }],
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-askUser',
            toolCallId: 'call-ask-2',
            state: 'output-available',
            input: {
              question: 'Chọn món?',
              options: ['Cháo yến mạch', 'Bún riêu chay'],
            },
            output: { answer: 'Cháo yến mạch' },
          },
        ],
      },
      {
        id: 'u2',
        role: 'user',
        parts: [{ type: 'text', text: 'Cháo yến mạch' }],
      },
    ]);

    await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Cháo yến mạch',
        new AbortController().signal,
        WEEK,
        'u2',
        'thread-ask-2',
      ),
    );

    const promptJson = JSON.stringify(model.doStreamCalls.at(-1)?.prompt);
    expect(promptJson).toContain('call-ask-2');
    expect(promptJson).toContain('Bữa sáng ăn gì?');
  });

  it('starts from the latest message when stored history no longer matches the tools', async () => {
    const service = await createService();
    history.loadContextMessages.mockResolvedValue([
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'Tin nhắn cũ' }],
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-askUser',
            toolCallId: 'call-old',
            state: 'output-available',
            // Saved before `options` became required.
            input: { question: 'Chọn món?' },
            output: { answer: 'Cháo' },
          },
        ],
      },
      {
        id: 'u2',
        role: 'user',
        parts: [{ type: 'text', text: 'Tin nhắn mới' }],
      },
    ]);

    await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Tin nhắn mới',
        new AbortController().signal,
        WEEK,
        'u2',
        'thread-stale',
      ),
    );

    const promptJson = JSON.stringify(model.doStreamCalls.at(-1)?.prompt);
    expect(promptJson).toContain('Tin nhắn mới');
    expect(promptJson).not.toContain('Tin nhắn cũ');
    expect(promptJson).not.toContain('call-old');
  });

  it('persists user turns and streamed or refused assistant messages into the provided thread', async () => {
    const service = await createService();
    const threadId = 'thread-uuid-1';

    const okChunks = await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Lên thực đơn ngày thứ Hai',
        new AbortController().signal,
        WEEK,
        'req-user-1',
        threadId,
      ),
    );

    expect(history.assertThreadAccess).toHaveBeenCalledWith(USER_ID, threadId);
    expect(history.recordUserMessage).toHaveBeenCalledWith(
      USER_ID,
      threadId,
      'Lên thực đơn ngày thứ Hai',
      'req-user-1',
    );
    expect(history.loadContextMessages).toHaveBeenCalledWith(
      USER_ID,
      threadId,
      runtimeConfig.PLANNER_CHAT_MAX_MESSAGES,
    );
    expect(history.recordAssistantMessage).toHaveBeenCalledTimes(1);
    const [savedUserId, savedThreadId, savedMessage] =
      history.recordAssistantMessage.mock.calls[0];
    expect(savedUserId).toBe(USER_ID);
    expect(savedThreadId).toBe(threadId);
    expect(savedMessage.role).toBe('assistant');
    expect(savedMessage.parts).toContainEqual({
      type: 'text',
      text: 'Mình đã gợi ý thực đơn.',
      state: 'done',
    });
    expect(okChunks[0]).toMatchObject({ type: 'start' });

    history.recordUserMessage.mockClear();
    history.recordAssistantMessage.mockClear();
    verdict = 'off_topic';

    const refusedChunks = await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Viết code',
        new AbortController().signal,
        WEEK,
        'req-user-2',
        threadId,
      ),
    );

    expect(history.recordUserMessage).toHaveBeenCalledWith(
      USER_ID,
      threadId,
      'Viết code',
      'req-user-2',
    );
    const startChunk = refusedChunks[0] as {
      type: string;
      messageId?: string;
      messageMetadata?: { refused?: boolean };
    };
    expect(startChunk.messageMetadata).toEqual({ refused: true });
    expect(history.recordAssistantMessage).toHaveBeenCalledWith(
      USER_ID,
      threadId,
      expect.objectContaining({
        id: startChunk.messageId,
        role: 'assistant',
        metadata: { refused: true },
      }),
    );
  });

  it('calls RestaurantMenuService when the planner invokes searchRestaurantDishes', async () => {
    dietary.findPlannerContext.mockResolvedValue({
      memory: {
        allergies: ['Dị ứng đậu phộng'],
        preferences: [],
      },
      nutrition: {
        heightCm: null,
        weightKg: null,
        targetWeightKg: null,
        birthYear: null,
        biologicalSex: null,
        activityLevel: null,
        nutritionGoal: null,
        bmi: null,
        bmiCategory: null,
        suggestedGoal: null,
        effectiveGoal: null,
        idealWeightMinKg: null,
        idealWeightMaxKg: null,
        bmr: null,
        tdee: null,
        dailyCalorieTarget: null,
        dailyCalorieMin: null,
        dailyCalorieMax: null,
        safetyNote: null,
        history: [],
      },
    });
    restaurantMenu.suggestForPlanner.mockResolvedValue([
      {
        id: 'dish-1',
        name: 'Bún bò chay Huế',
        category: 'Món nước',
        priceVnd: 45000,
        description: 'Đậm vị sả ớt',
        imageUrl: null,
        restaurant: {
          pageUserId: 'page-1',
          username: 'chay.hue',
          name: 'Chay An Nhiên',
          avatarUrl: null,
          address: '10 Quang Trung, Hà Nội',
          averageRating: 4.9,
          reviewCount: 15,
        },
        avoidedMatches: [],
      },
    ]);
    steps = [
      [
        {
          type: 'tool-call',
          toolCallId: 'call-rest',
          toolName: 'searchRestaurantDishes',
          input: JSON.stringify({ query: 'bún bò chay', limit: 5 }),
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage,
        },
      ],
      textChunks,
    ];

    const service = await createService();
    const chunks = await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Gợi ý món bún bò chay ở nhà hàng',
        new AbortController().signal,
        WEEK,
      ),
    );

    expect(restaurantMenu.suggestForPlanner).toHaveBeenCalledWith(
      'bún bò chay',
      5,
      expect.arrayContaining(['đậu phộng']),
    );
    expect(replyText(chunks)).toBe('Mình đã gợi ý thực đơn.');
  });

  it('keeps the full history window in voice mode and refunds quota if thread access fails', async () => {
    const service = await createService();

    await convertReadableStreamToArray(
      await service.stream(
        USER_ID,
        'Mở thực đơn hôm nay',
        new AbortController().signal,
        WEEK,
        'req-voice-1',
        'thread-voice-1',
        { voice: true },
      ),
    );

    expect(history.loadContextMessages).toHaveBeenCalledWith(
      USER_ID,
      'thread-voice-1',
      runtimeConfig.PLANNER_CHAT_MAX_MESSAGES,
    );

    aiUsage.refund.mockClear();
    history.recordUserMessage.mockClear();
    history.assertThreadAccess.mockRejectedValueOnce(new Error('not owner'));

    await expect(
      service.stream(
        USER_ID,
        'Mở thực đơn hôm nay',
        new AbortController().signal,
        WEEK,
        'req-voice-2',
        'thread-foreign',
        { voice: true },
      ),
    ).rejects.toThrow('not owner');
    expect(aiUsage.refund).toHaveBeenCalledWith(TICKET);
    expect(history.recordUserMessage).not.toHaveBeenCalled();
  });
});
