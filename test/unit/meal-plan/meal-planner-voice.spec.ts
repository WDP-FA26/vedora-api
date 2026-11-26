import { ConfigService } from '@nestjs/config';
import { asSchema, simulateReadableStream, type UIMessageChunk } from 'ai';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { FeatureUnavailableException } from '@src/common/exceptions/feature-unavailable.exception.js';
import { QuotaReachedException } from '@src/common/exceptions/quota-reached.exception.js';
import type { AiUsageService } from '@src/subscriptions/ai-usage.service.js';
import type { MealLogService } from '@src/meal-plan/meal-log/meal-log.service.js';
import type { MealPlanService } from '@src/meal-plan/meal-plan.service.js';
import type { MealPlannerChatHistoryService } from '@src/meal-plan/meal-planner-chat-history.service.js';
import { MealPlannerChatService } from '@src/meal-plan/meal-planner-chat.service.js';
import { logMealTool } from '@src/meal-plan/tools/log-meal.tool.js';
import { undoLastChangeTool } from '@src/meal-plan/tools/undo-last-change.tool.js';
import { updateBodyMetricsTool } from '@src/meal-plan/tools/update-body-metrics.tool.js';
import { convertReadableStreamToArray } from 'ai/test';
import {
  bodyMetricsText,
  setScreenTool,
} from '@src/meal-plan/tools/voice-screen.tools.js';
import {
  deriveVoiceToolEffects,
  withVoiceStreamEffects,
} from '@src/meal-plan/voice/voice-stream-effects.js';
import { voiceScreenContext } from '@src/meal-plan/meal-planner.prompt.js';
import { MealPlannerVoiceService } from '@src/meal-plan/voice/meal-planner-voice.service.js';
import type { DietaryService } from '@src/recipes/dietary.service.js';
import {
  AiFeature,
  CalorieSource,
  MealLogSource,
  MealSection,
  Weekday,
} from '@src/mongo/models.js';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const THREAD_ID = '8f0c1f2e-5b7a-4d3c-9e1f-2a3b4c5d6e7f';
const WEEK = '2026-11-23';
const RECIPE_ID = 'd1a2d3e4-0000-4000-8000-000000000001';
const execOptions = { toolCallId: 'call-1', messages: [], context: {} };

function emptyStream() {
  return simulateReadableStream<UIMessageChunk>({
    initialDelayInMs: null,
    chunkDelayInMs: null,
    chunks: [{ type: 'start' }, { type: 'finish' }],
  });
}

describe('MealPlannerVoiceService', () => {
  let chat: DeepMockProxy<MealPlannerChatService>;
  let usage: DeepMockProxy<AiUsageService>;

  beforeEach(() => {
    chat = mockDeep<MealPlannerChatService>();
    chat.stream.mockResolvedValue(emptyStream());
    usage = mockDeep<AiUsageService>();
  });

  const service = (config: Record<string, string> = {}) =>
    new MealPlannerVoiceService(new ConfigService(config), chat, usage);

  it('refuses a session when no gateway key is configured', async () => {
    await expect(service().createSession(USER_ID)).rejects.toThrow(
      FeatureUnavailableException,
    );
  });

  it('refuses a session once the chat quota is used up', async () => {
    usage.hasAllowance.mockResolvedValue(false);

    await expect(
      service({ AI_GATEWAY_API_KEY: 'test-key' }).createSession(USER_ID),
    ).rejects.toThrow(QuotaReachedException);
    expect(usage.hasAllowance).toHaveBeenCalledWith(
      USER_ID,
      AiFeature.MEAL_PLAN_CHAT,
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

  it('passes what the page shows to the planner', async () => {
    const screen = { weekStart: WEEK, panel: 'bodyMetrics' as const };

    await service().turn(
      USER_ID,
      { weekStart: WEEK, threadId: THREAD_ID, message: 'đóng lại đi', screen },
      new AbortController().signal,
    );

    expect(chat.stream.mock.calls[0][6]).toEqual({
      voice: true,
      screen,
    });
  });
});

describe('voice tools', () => {
  it('setScreen opens a recipe at the section asked for', async () => {
    const mealPlan = mockDeep<MealPlanService>();
    mealPlan.recipeInstructions.mockResolvedValue({
      title: 'Cơm gạo lứt muối mè',
    } as Awaited<ReturnType<MealPlanService['recipeInstructions']>>);
    const toolDef = setScreenTool(
      mealPlan,
      mockDeep<DietaryService>(),
      USER_ID,
      WEEK,
    );

    const output = await toolDef.execute?.(
      { view: 'recipe', recipeId: RECIPE_ID, section: 'steps' },
      execOptions,
    );

    expect(output).toMatchObject({
      applied: true,
      view: 'recipe',
      recipeId: RECIPE_ID,
      title: 'Cơm gạo lứt muối mè',
      section: 'steps',
    });
  });

  it('setScreen scrolls the recipe on screen when no id is given', async () => {
    const mealPlan = mockDeep<MealPlanService>();
    mealPlan.recipeInstructions.mockResolvedValue({
      title: 'Cơm gạo lứt muối mè',
    } as Awaited<ReturnType<MealPlanService['recipeInstructions']>>);
    const toolDef = setScreenTool(
      mealPlan,
      mockDeep<DietaryService>(),
      USER_ID,
      WEEK,
      {
        weekStart: WEEK,
        panel: 'recipe',
        recipeId: RECIPE_ID,
      },
    );

    const output = await toolDef.execute?.(
      { view: 'recipe', section: 'ingredients' },
      execOptions,
    );

    expect(mealPlan.recipeInstructions).toHaveBeenCalledWith(
      USER_ID,
      RECIPE_ID,
    );
    expect(output).toMatchObject({ applied: true, section: 'ingredients' });
  });

  it('setScreen says what to fix instead of opening a recipe without an id', async () => {
    const toolDef = setScreenTool(
      mockDeep<MealPlanService>(),
      mockDeep<DietaryService>(),
      USER_ID,
      WEEK,
    );

    const output = await toolDef.execute?.({ view: 'recipe' }, execOptions);

    expect(output).toMatchObject({ applied: false, view: 'recipe' });
    expect(output?.problem).toContain('recipeId');
  });

  it('setScreen opens a recipe directly by query and preserves done', async () => {
    const mealPlan = mockDeep<MealPlanService>();
    mealPlan.suggestions.mockResolvedValue([
      {
        id: RECIPE_ID,
        title: 'Bún riêu chay',
        tag: null,
        minutes: 25,
        caloriesPerServing: 380,
        nutritionPillars: [],
        ingredients: [],
        avoided: [],
      },
    ]);
    const toolDef = setScreenTool(
      mealPlan,
      mockDeep<DietaryService>(),
      USER_ID,
      WEEK,
    );

    const output = await toolDef.execute?.(
      { view: 'recipe', query: 'bún riêu', done: true },
      execOptions,
    );

    expect(mealPlan.suggestions).toHaveBeenCalledWith(USER_ID, 'bún riêu');
    expect(mealPlan.recipeInstructions).not.toHaveBeenCalled();
    expect(output).toMatchObject({
      applied: true,
      view: 'recipe',
      recipeId: RECIPE_ID,
      title: 'Bún riêu chay',
      done: true,
    });
  });

  it('setScreen returns a refusal when query finds no matching dish', async () => {
    const mealPlan = mockDeep<MealPlanService>();
    mealPlan.suggestions.mockResolvedValue([]);
    const toolDef = setScreenTool(
      mealPlan,
      mockDeep<DietaryService>(),
      USER_ID,
      WEEK,
    );

    const output = await toolDef.execute?.(
      { view: 'recipe', query: 'món lạ', done: true },
      execOptions,
    );

    expect(output).toMatchObject({ applied: false, view: 'recipe' });
    expect(output?.done).toBeUndefined();
  });

  it('setScreen goes back to the calendar on the week shown', async () => {
    const toolDef = setScreenTool(
      mockDeep<MealPlanService>(),
      mockDeep<DietaryService>(),
      USER_ID,
      WEEK,
      { weekStart: '2026-11-30', panel: 'eatingLog' },
    );

    const output = await toolDef.execute?.(
      { view: 'calendar', day: Weekday.WED },
      execOptions,
    );

    expect(output).toMatchObject({
      applied: true,
      view: 'calendar',
      weekStart: '2026-11-30',
      day: Weekday.WED,
    });
  });

  it('voiceScreenContext names the open recipe and the part shown', () => {
    const text = voiceScreenContext(
      {
        weekStart: WEEK,
        day: Weekday.FRI,
        panel: 'recipe',
        recipeId: RECIPE_ID,
        recipeSection: 'steps',
      },
      'Cơm gạo lứt muối mè',
    );

    expect(text).toContain('Thứ Sáu');
    expect(text).toContain('"Cơm gạo lứt muối mè"');
    expect(text).toContain('phần cách làm');
  });

  it('logMeal writes a catalog dish through the meal log service', async () => {
    const mealLog = mockDeep<MealLogService>();
    mealLog.create.mockResolvedValue({
      id: 'e1',
      date: WEEK,
      section: MealSection.LUNCH,
      source: MealLogSource.RECIPE,
      recipeId: RECIPE_ID,
      name: 'Đậu hũ sốt cà',
      servings: 1,
      caloriesPerServing: 320,
      calories: 320,
      calorieSource: CalorieSource.RECIPE,
      calorieNote: null,
      calorieReferences: [],
      createdAt: new Date().toISOString(),
    });
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

  it('logMeal accepts exactly one of recipeId and name', async () => {
    const toolDef = logMealTool(mockDeep<MealLogService>(), USER_ID);
    const schema = asSchema(toolDef.inputSchema);
    const accepts = async (value: unknown): Promise<boolean> => {
      const result = await schema.validate?.(value);
      return result?.success === true;
    };

    expect(
      await accepts({
        date: WEEK,
        section: 'LUNCH',
        recipeId: RECIPE_ID,
        name: 'Phở',
      }),
    ).toBe(false);
    expect(await accepts({ date: WEEK, section: 'LUNCH' })).toBe(false);
    expect(
      await accepts({ date: WEEK, section: 'LUNCH', name: 'Phở chay' }),
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

describe('voice stream effects', () => {
  it('derives screen, refresh, progress, and summary for voice tools', () => {
    expect(
      deriveVoiceToolEffects('editPlan', {
        weekStart: WEEK,
        applied: true,
        days: [{ day: Weekday.MON }, { day: Weekday.SUN }],
      }),
    ).toEqual({
      refresh: { plan: true },
      screen: {
        focus: { kind: 'planDay', weekStart: WEEK, day: Weekday.MON },
        close: null,
      },
      progress: 'Đã lưu thay đổi thực đơn cho Thứ Hai, Chủ nhật, đang làm tiếp.',
    });

    expect(
      deriveVoiceToolEffects('setScreen', {
        applied: true,
        view: 'recipe',
        recipeId: RECIPE_ID,
        title: 'Phở chay',
        section: 'steps',
        step: 3,
        scroll: null,
        weekStart: null,
        day: null,
        date: null,
        metrics: null,
        problem: null,
      }),
    ).toEqual({
      screen: {
        focus: {
          kind: 'recipe',
          recipeId: RECIPE_ID,
          title: 'Phở chay',
          section: 'steps',
          step: 3,
        },
        close: null,
      },
      screenSummary: 'Đã mở công thức "Phở chay" trên màn hình, ở bước 3.',
    });

    expect(deriveVoiceToolEffects('endCall', { ended: true })).toEqual({
      endCall: true,
      actionSummary:
        'Người dùng muốn kết thúc cuộc gọi, hãy chào tạm biệt ngắn gọn.',
    });
  });

  it('emits transient data parts and prioritizes write-tool summary over setScreen when no text is streamed', async () => {
    const input = simulateReadableStream<UIMessageChunk>({
      initialDelayInMs: null,
      chunkDelayInMs: null,
      chunks: [
        { type: 'start', messageId: 'm1' },
        {
          type: 'tool-input-available',
          toolCallId: 'c1',
          toolName: 'logMeal',
          input: {},
        },
        {
          type: 'tool-output-available',
          toolCallId: 'c1',
          output: {
            entry: {
              date: '2026-11-25',
              section: MealSection.LUNCH,
              name: 'Phở chay',
              calories: 420,
            },
          },
        },
        {
          type: 'tool-input-available',
          toolCallId: 'c2',
          toolName: 'setScreen',
          input: {},
        },
        {
          type: 'tool-output-available',
          toolCallId: 'c2',
          output: {
            applied: true,
            view: 'eatingLog',
            recipeId: null,
            title: null,
            section: null,
            step: null,
            scroll: null,
            weekStart: null,
            day: null,
            date: '2026-11-25',
            metrics: null,
            problem: null,
          },
        },
        { type: 'finish' },
      ],
    });

    const out = await convertReadableStreamToArray(
      withVoiceStreamEffects(input),
    );
    const dataParts = out.filter((chunk) => chunk.type.startsWith('data-'));

    expect(dataParts).toContainEqual({
      type: 'data-refresh',
      data: { log: true },
      transient: true,
    });
    expect(dataParts).toContainEqual({
      type: 'data-screen',
      data: {
        focus: { kind: 'eatingLog', date: '2026-11-25' },
        close: null,
      },
      transient: true,
    });
    expect(dataParts).toContainEqual({
      type: 'data-progress',
      data: { text: 'Đã ghi món vào nhật ký, đang làm tiếp.' },
      transient: true,
    });
    expect(dataParts).toContainEqual({
      type: 'data-summary',
      data: {
        text: 'Đã ghi món "Phở chay" vào nhật ký bữa trưa ngày 2026-11-25, khoảng 420 kcal.',
      },
      transient: true,
    });
  });

  it('omits data-summary when the assistant streams text', async () => {
    const input = simulateReadableStream<UIMessageChunk>({
      initialDelayInMs: null,
      chunkDelayInMs: null,
      chunks: [
        { type: 'start', messageId: 'm1' },
        {
          type: 'tool-input-available',
          toolCallId: 'c1',
          toolName: 'setScreen',
          input: {},
        },
        {
          type: 'tool-output-available',
          toolCallId: 'c1',
          output: {
            applied: true,
            view: 'bodyMetrics',
            recipeId: null,
            title: null,
            section: null,
            step: null,
            scroll: null,
            weekStart: null,
            day: null,
            date: null,
            metrics: null,
            problem: null,
          },
        },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Đây là bảng chỉ số.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish' },
      ],
    });

    const out = await convertReadableStreamToArray(
      withVoiceStreamEffects(input),
    );
    expect(out.some((chunk) => chunk.type === 'data-summary')).toBe(false);
  });
});
