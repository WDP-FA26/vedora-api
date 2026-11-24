import { ConfigService } from '@nestjs/config';
import { FakeModel, providerError } from '@nestjs/ai/testing';
import { simulateReadableStream, type UIMessageChunk } from 'ai';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { FeatureUnavailableException } from '@src/common/exceptions/feature-unavailable.exception.js';
import type { MealLogService } from '@src/meal-plan/meal-log/meal-log.service.js';
import type { MealPlanService } from '@src/meal-plan/meal-plan.service.js';
import type { MealPlannerChatHistoryService } from '@src/meal-plan/meal-planner-chat-history.service.js';
import { MealPlannerChatService } from '@src/meal-plan/meal-planner-chat.service.js';
import { logMealTool } from '@src/meal-plan/tools/log-meal.tool.js';
import { undoLastChangeTool } from '@src/meal-plan/tools/undo-last-change.tool.js';
import { updateBodyMetricsTool } from '@src/meal-plan/tools/update-body-metrics.tool.js';
import {
  bodyMetricsText,
  showRecipeTool,
} from '@src/meal-plan/tools/voice-screen.tools.js';
import { MealPlannerVoiceService } from '@src/meal-plan/voice/meal-planner-voice.service.js';
import type { DietaryService } from '@src/recipes/dietary.service.js';
import { MealSection, Weekday } from '@src/mongo/models.js';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const THREAD_ID = '8f0c1f2e-5b7a-4d3c-9e1f-2a3b4c5d6e7f';
const WEEK = '2026-11-23';
const RECIPE_ID = 'd1a2d3e4-0000-4000-8000-000000000001';
const execOptions = { toolCallId: 'call-1', messages: [], context: {} };
const WEB_REQUEST = {
  toolCallId: 'call-web',
  reason: 'Tìm nơi bán tempeh ở Đà Nẵng',
};

function emptyStream() {
  return simulateReadableStream<UIMessageChunk>({
    initialDelayInMs: null,
    chunkDelayInMs: null,
    chunks: [{ type: 'start' }, { type: 'finish' }],
  });
}

describe('MealPlannerVoiceService', () => {
  let chat: DeepMockProxy<MealPlannerChatService>;
  let consent = 'approve';
  let failConsent = false;
  const decisionModel = new FakeModel(() =>
    failConsent ? providerError(500) : { object: { choice: consent } },
  );

  beforeEach(() => {
    chat = mockDeep<MealPlannerChatService>();
    chat.stream.mockResolvedValue(emptyStream());
    consent = 'approve';
    failConsent = false;
  });

  const service = () =>
    new MealPlannerVoiceService(new ConfigService({}), chat, decisionModel);

  it('refuses a session when no gateway key is configured', async () => {
    await expect(service().createSession()).rejects.toThrow(
      FeatureUnavailableException,
    );
  });

  it('streams the planner in voice mode on the chat thread', async () => {
    const signal = new AbortController().signal;

    await service().turn(
      USER_ID,
      {
        weekStart: WEEK,
        threadId: THREAD_ID,
        message: 'trưa nay mình ăn phở chay',
        requestId: 'd1',
      },
      signal,
    );

    expect(chat.stream).toHaveBeenCalledWith(
      USER_ID,
      'trưa nay mình ăn phở chay',
      signal,
      WEEK,
      'd1',
      THREAD_ID,
      { voice: true },
    );
  });

  it('turns a spoken yes into the web search approval', async () => {
    await service().turn(
      USER_ID,
      {
        weekStart: WEEK,
        threadId: THREAD_ID,
        message: 'ừ tìm đi',
        webSearchRequest: WEB_REQUEST,
      },
      new AbortController().signal,
    );

    expect(chat.stream.mock.calls[0][6]).toEqual({
      voice: true,
      allowWebSearch: true,
      toolOutput: {
        tool: 'requestWebSearch',
        toolCallId: 'call-web',
        output: { approved: true },
      },
    });
  });

  it('records a spoken no as a refusal, without web search', async () => {
    consent = 'decline';

    await service().turn(
      USER_ID,
      {
        weekStart: WEEK,
        threadId: THREAD_ID,
        message: 'thôi khỏi',
        webSearchRequest: WEB_REQUEST,
      },
      new AbortController().signal,
    );

    expect(chat.stream.mock.calls[0][6]).toMatchObject({
      allowWebSearch: false,
      toolOutput: { output: { approved: false } },
    });
  });

  it('treats an unclear or unreadable answer as a new message', async () => {
    consent = 'unclear';
    await service().turn(
      USER_ID,
      {
        weekStart: WEEK,
        threadId: THREAD_ID,
        message: 'mà tối nay ăn gì',
        webSearchRequest: WEB_REQUEST,
      },
      new AbortController().signal,
    );
    failConsent = true;
    await service().turn(
      USER_ID,
      {
        weekStart: WEEK,
        threadId: THREAD_ID,
        message: 'ừ',
        webSearchRequest: WEB_REQUEST,
      },
      new AbortController().signal,
    );

    expect(chat.stream.mock.calls[0][6]).toEqual({ voice: true });
    expect(chat.stream.mock.calls[1][6]).toEqual({ voice: true });
  });
});

describe('voice tools', () => {
  it('showRecipe reports a missing recipe instead of showing it', async () => {
    const mealPlan = mockDeep<MealPlanService>();
    mealPlan.recipeInstructions.mockResolvedValue(null);
    const toolDef = showRecipeTool(mealPlan, USER_ID);

    const output = await toolDef.execute?.({ recipeId: 'nope' }, execOptions);

    expect(output).toEqual({ shown: false, recipeId: 'nope', title: null });
  });

  it('logMeal writes a catalog dish through the meal log service', async () => {
    const mealLog = mockDeep<MealLogService>();
    mealLog.create.mockResolvedValue({
      id: 'e1',
      date: WEEK,
      section: MealSection.LUNCH,
      source: 'RECIPE',
      recipeId: RECIPE_ID,
      name: 'Đậu hũ sốt cà',
      servings: 1,
      caloriesPerServing: 320,
      calories: 320,
      calorieSource: 'RECIPE',
      calorieNote: null,
      calorieReferences: [],
      createdAt: new Date(),
    } as Awaited<ReturnType<MealLogService['create']>>);
    const toolDef = logMealTool(mealLog, USER_ID);

    await toolDef.execute?.(
      { date: WEEK, section: MealSection.LUNCH, recipeId: RECIPE_ID },
      execOptions,
    );

    expect(mealLog.create).toHaveBeenCalledWith(USER_ID, {
      date: WEEK,
      section: MealSection.LUNCH,
      recipeId: RECIPE_ID,
      servings: undefined,
      name: undefined,
      caloriesPerServing: undefined,
    });
  });

  it('logMeal accepts exactly one of recipeId and name', () => {
    const toolDef = logMealTool(mockDeep<MealLogService>(), USER_ID);
    const schema = toolDef.inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };

    expect(
      schema.safeParse({
        date: WEEK,
        section: 'LUNCH',
        recipeId: RECIPE_ID,
        name: 'Phở',
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ date: WEEK, section: 'LUNCH' }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ date: WEEK, section: 'LUNCH', name: 'Phở chay' })
        .success,
    ).toBe(true);
  });

  it('updateBodyMetrics saves only the given fields, rounded to 0.1 kg', async () => {
    const dietary = mockDeep<DietaryService>();
    dietary.saveNutrition.mockResolvedValue({
      heightCm: 165,
      weightKg: 58.3,
      targetWeightKg: null,
      bmi: 21.4,
      bmiCategory: 'NORMAL',
      dailyCalorieTarget: 1800,
    } as Awaited<ReturnType<DietaryService['saveNutrition']>>);
    const toolDef = updateBodyMetricsTool(dietary, USER_ID);

    const output = await toolDef.execute?.({ weightKg: 58.26 }, execOptions);

    expect(dietary.saveNutrition).toHaveBeenCalledWith(USER_ID, {
      heightCm: undefined,
      weightKg: 58.3,
      targetWeightKg: undefined,
      activityLevel: undefined,
      nutritionGoal: undefined,
    });
    expect(output).toMatchObject({ bmi: 21.4, dailyCalorieTarget: 1800 });
  });

  it('undoLastChange says which days went back and which had passed', async () => {
    const history = mockDeep<MealPlannerChatHistoryService>();
    const toolDef = undoLastChangeTool(history, USER_ID, THREAD_ID);

    const said = await toolDef.toModelOutput?.({
      toolCallId: 'call-1',
      input: {},
      output: {
        messageId: 'a2',
        weeks: [
          {
            weekStart: WEEK,
            restored: [Weekday.WED],
            skipped: [Weekday.MON],
            droppedDishes: 1,
          },
        ],
      },
    });
    const nothing = await toolDef.toModelOutput?.({
      toolCallId: 'call-2',
      input: {},
      output: { messageId: null, weeks: [] },
    });

    expect(said).toEqual({
      type: 'text',
      value: `Tuần ${WEEK}: đã đưa về như trước Thứ Tư; Thứ Hai đã qua nên giữ nguyên; 1 món không còn dùng được nên bỏ ra.`,
    });
    expect(nothing).toMatchObject({ type: 'text' });
  });

  it('bodyMetricsText says when the profile is empty', () => {
    expect(
      bodyMetricsText({
        heightCm: null,
        weightKg: null,
        targetWeightKg: null,
        bmi: null,
        bmiCategory: null,
        dailyCalorieTarget: null,
      }),
    ).toBe('Người dùng chưa nhập chiều cao và cân nặng.');
  });
});
