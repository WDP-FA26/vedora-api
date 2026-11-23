import { MockLanguageModelV4 } from 'ai/test';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { MealPlanDto } from '../../../src/meal-plan/dto/meal-plan.dto.js';
import type { MealPlanService } from '../../../src/meal-plan/meal-plan.service.js';
import { verifyMealPlanAllergiesTool } from '../../../src/meal-plan/tools/allergy-verifier-subagent.tool.js';
import { askUserTool } from '../../../src/meal-plan/tools/ask-user.tool.js';
import { autoBalancePlanTool } from '../../../src/meal-plan/tools/auto-balance-plan.tool.js';
import { editPlanTool } from '../../../src/meal-plan/tools/edit-plan.tool.js';
import { fillSlotsTool } from '../../../src/meal-plan/tools/fill-slots.tool.js';
import { getPlanTool } from '../../../src/meal-plan/tools/get-plan.tool.js';
import { getRecipeTool } from '../../../src/meal-plan/tools/get-recipe.tool.js';
import {
  changeFeedback,
  mergeChanges,
} from '../../../src/meal-plan/tools/proposal-text.js';
import { searchRecipesTool } from '../../../src/meal-plan/tools/search-recipes.tool.js';
import { MealSection, RecipeTag, Weekday } from '../../../src/mongo/models.js';

type ExecOptions = Parameters<
  NonNullable<ReturnType<typeof searchRecipesTool>['execute']>
>[1];

const execOptions: ExecOptions = {
  toolCallId: 'call-1',
  messages: [],
  context: {},
};

describe('Meal planner AI tools', () => {
  const userId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
  const WEEK = '2026-11-16';
  const recipe1 = 'd1a2d3e4-0000-4000-8000-000000000001';
  let mealPlan: DeepMockProxy<MealPlanService>;

  beforeEach(() => {
    mealPlan = mockDeep<MealPlanService>();
  });

  describe('getRecipeTool', () => {
    it('formats ingredients and steps for the model', async () => {
      const toolDef = getRecipeTool(mealPlan, userId);
      const recipe = {
        id: 'rec-1',
        title: 'Đậu hũ sốt cà',
        description: null,
        servings: 2,
        minutes: 15,
        ingredients: [
          { name: 'Đậu hũ', quantity: 2, unit: 'miếng', note: null },
          { name: 'Hành lá', quantity: null, unit: null, note: 'thái nhỏ' },
        ],
        steps: ['Chiên đậu', 'Sốt cà'],
        avoidedIngredients: [],
      };
      mealPlan.recipeInstructions.mockResolvedValue(recipe);

      const output = await toolDef.execute?.(
        { recipeId: 'rec-1' },
        execOptions,
      );
      expect(mealPlan.recipeInstructions).toHaveBeenCalledWith(userId, 'rec-1');
      expect(output).toEqual(recipe);

      const modelOut = await toolDef.toModelOutput?.({
        input: { recipeId: 'rec-1' },
        toolCallId: 'call-1',
        output: recipe,
      });
      expect(modelOut).toEqual({
        type: 'text',
        value:
          'Đậu hũ sốt cà\n2 khẩu phần | 15 phút\nNguyên liệu:\n- Đậu hũ: 2 miếng\n- Hành lá (thái nhỏ)\nCách làm:\n1. Chiên đậu\n2. Sốt cà',
      });
    });

    it('warns first when the recipe has an ingredient the user avoids', async () => {
      const toolDef = getRecipeTool(mealPlan, userId);
      const modelOut = await toolDef.toModelOutput?.({
        input: { recipeId: 'rec-1' },
        toolCallId: 'call-1',
        output: {
          id: 'rec-1',
          title: 'Trà chanh dây',
          description: null,
          servings: 1,
          minutes: 5,
          ingredients: [
            { name: 'Chanh dây', quantity: 1, unit: 'quả', note: null },
          ],
          steps: ['Pha trà'],
          avoidedIngredients: ['Chanh dây'],
        },
      });
      expect(modelOut).toEqual({
        type: 'text',
        value:
          'Trà chanh dây\nAVOIDED: the user avoids Chanh dây. Warn them before anything else, and never put this recipe in their plan.\n1 khẩu phần | 5 phút\nNguyên liệu:\n- Chanh dây: 1 quả\nCách làm:\n1. Pha trà',
      });
    });

    it('says when the recipe is not available', async () => {
      const toolDef = getRecipeTool(mealPlan, userId);
      const modelOut = await toolDef.toModelOutput?.({
        input: { recipeId: 'x' },
        toolCallId: 'call-1',
        output: null,
      });
      expect(modelOut).toEqual({ type: 'text', value: 'Recipe not found.' });
    });
  });

  describe('searchRecipesTool', () => {
    it('delegates to mealPlan.suggestions and formats recipes with and without minutes', async () => {
      const toolDef = searchRecipesTool(mealPlan, userId);
      const suggestions = [
        {
          id: 'rec-1',
          title: 'Đậu hũ sốt cà',
          tag: RecipeTag.STIR_FRY,
          minutes: 15,
          ingredients: ['Đậu hũ', 'Cà chua'],
          description: 'Món mặn đậm đà',
          avoidedIngredients: [],
        },
        {
          id: 'rec-2',
          title: 'Canh nấm',
          tag: null,
          minutes: null,
          ingredients: ['Nấm'],
          description: null,
          avoidedIngredients: ['Nấm'],
        },
      ];
      mealPlan.suggestions.mockResolvedValue(suggestions);

      const output = await toolDef.execute?.(
        {
          query: 'đậu hũ',
          tag: RecipeTag.STIR_FRY,
          tags: [RecipeTag.STIR_FRY, RecipeTag.SOUP],
          exclude: ['chiên'],
          maxMinutes: 30,
        },
        execOptions,
      );
      expect(mealPlan.suggestions).toHaveBeenCalledWith(userId, 'đậu hũ', {
        tag: RecipeTag.STIR_FRY,
        tags: [RecipeTag.STIR_FRY, RecipeTag.SOUP],
        exclude: ['chiên'],
        maxMinutes: 30,
      });
      expect(output).toEqual(suggestions);

      const modelOut = await toolDef.toModelOutput?.({
        input: { query: 'đậu hũ' },
        toolCallId: 'call-1',
        output: suggestions,
      });
      expect(modelOut).toEqual({
        type: 'text',
        value:
          'rec-1 | Đậu hũ sốt cà | STIR_FRY | 15 phút | Đậu hũ, Cà chua | Món mặn đậm đà\nrec-2 | Canh nấm | chưa phân loại | ? phút | Nấm | AVOIDED: Nấm',
      });
    });

    it('returns a clear message when no recipes match', async () => {
      const toolDef = searchRecipesTool(mealPlan, userId);
      mealPlan.suggestions.mockResolvedValue([]);

      const output = await toolDef.execute?.({}, execOptions);
      expect(mealPlan.suggestions).toHaveBeenCalledWith(userId, undefined, {
        tag: undefined,
        tags: undefined,
        exclude: undefined,
        maxMinutes: undefined,
      });
      if (!Array.isArray(output)) throw new Error('expected array output');

      const modelOut = await toolDef.toModelOutput?.({
        input: {},
        toolCallId: 'call-1',
        output,
      });
      expect(modelOut).toEqual({
        type: 'text',
        value: 'No recipes found.',
      });
    });
  });

  describe('getPlanTool', () => {
    it('formats the saved weekly plan', async () => {
      const toolDef = getPlanTool(mealPlan, userId, WEEK);
      const savedPlan = {
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
            recipes:
              day === Weekday.MON && section === MealSection.LUNCH
                ? [
                    {
                      id: recipe1,
                      title: 'Cơm gạo lứt',
                      imageUrl: null,
                      tag: RecipeTag.RICE,
                      servings: 1,
                      prepMinutes: 10,
                      cookMinutes: 15,
                      ingredients: [],
                      steps: ['Nấu'],
                    },
                  ]
                : [],
          })),
        })),
        problems: [],
      };
      mealPlan.find.mockResolvedValue(savedPlan);

      const output = await toolDef.execute?.({}, execOptions);
      expect(mealPlan.find).toHaveBeenCalledWith(userId, WEEK);
      expect(output).toEqual({ plan: savedPlan });

      if (!output || Symbol.asyncIterator in output) {
        throw new Error('expected plan output');
      }
      const modelOut = await toolDef.toModelOutput?.({
        input: {},
        toolCallId: 'call-1',
        output,
      });
      expect(modelOut).toEqual({
        type: 'text',
        value: expect.stringContaining(
          `- Thứ Hai: trưa: Cơm gạo lứt (id ${recipe1})`,
        ) as unknown,
      });
      expect(modelOut).toEqual({
        type: 'text',
        value: expect.stringContaining('- Thứ Tư: (empty)') as unknown,
      });
    });
  });

  describe('fillSlotsTool', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      // Thursday 2026-11-19 in Vietnam: Monday to Wednesday have passed.
      vi.setSystemTime(new Date('2026-11-19T03:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const request = {
      days: [Weekday.FRI],
      sections: [MealSection.LUNCH],
      onlyEmpty: true,
      maxMinutes: 30,
    };
    const section = (recipes: { id: string; title: string; tag: null }[]) => ({
      section: MealSection.LUNCH,
      recipes,
      previous: [],
    });

    it('works on the week the model names and reports days that have passed', async () => {
      const toolDef = fillSlotsTool(mealPlan, userId, WEEK);
      const result = {
        weekStart: WEEK,
        days: [],
        problems: [],
        applied: false,
        filled: 0,
        allSlotsAlreadyFilled: false,
      };
      mealPlan.fillPlan.mockResolvedValue(result);

      await toolDef.execute?.(
        { ...request, days: [Weekday.FRI], weekStart: '2026-11-23' },
        execOptions,
      );
      expect(mealPlan.fillPlan).toHaveBeenLastCalledWith(userId, {
        ...request,
        days: [Weekday.FRI],
        weekStart: '2026-11-23',
      });

      const output = await toolDef.execute?.(
        { ...request, days: [Weekday.WED, Weekday.FRI] },
        execOptions,
      );
      const passed = {
        ...result,
        passedDays: [{ day: Weekday.WED, date: '2026-11-18' }],
      };
      expect(output).toEqual(passed);
      const modelOut = await toolDef.toModelOutput?.({
        input: request,
        toolCallId: 'call-1',
        output: passed,
      });
      expect(modelOut).toEqual({
        type: 'text',
        value: expect.stringContaining(
          'DAY_PASSED: Thứ Tư 2026-11-18 came before today',
        ) as unknown,
      });
    });

    it('refuses a week outside the plannable range', () => {
      const toolDef = fillSlotsTool(mealPlan, userId, WEEK);
      const schema = toolDef.inputSchema;
      if (!('safeParse' in schema)) throw new Error('expected a zod schema');
      expect(
        schema.safeParse({ ...request, weekStart: '2026-12-14' }).success,
      ).toBe(true);
      expect(
        schema.safeParse({ ...request, weekStart: '2026-12-21' }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...request, weekStart: '2026-11-09' }).success,
      ).toBe(false);
    });

    it('passes the request to fillPlan and summarizes the saved change', async () => {
      const toolDef = fillSlotsTool(mealPlan, userId, WEEK);
      const result = {
        weekStart: WEEK,
        days: [
          {
            day: Weekday.MON,
            sections: [
              section([{ id: 'rec-1', title: 'Cơm gạo lứt', tag: null }]),
            ],
          },
        ],
        problems: [],
        applied: true,
        filled: 1,
        allSlotsAlreadyFilled: false,
      };
      mealPlan.fillPlan.mockResolvedValue(result);

      const output = await toolDef.execute?.(request, execOptions);
      expect(mealPlan.fillPlan).toHaveBeenCalledWith(userId, {
        ...request,
        weekStart: WEEK,
      });
      expect(output).toEqual(result);

      const modelOut = await toolDef.toModelOutput?.({
        input: request,
        toolCallId: 'call-1',
        output: result,
      });
      expect(modelOut).toEqual({
        type: 'text',
        value: [
          "Saved to the user's plan for the week of 2026-11-16; the app shows the change in the chat and the user can rewind it. Changes:",
          '- Thứ Hai: trưa: Cơm gạo lứt (id rec-1)',
        ].join('\n'),
      });
    });

    it('reports when slots are already filled or when no dish matches', async () => {
      const toolDef = fillSlotsTool(mealPlan, userId, WEEK);

      const alreadyFilled = {
        weekStart: WEEK,
        days: [],
        problems: [],
        applied: false,
        filled: 0,
        allSlotsAlreadyFilled: true,
      };
      expect(
        await toolDef.toModelOutput?.({
          input: request,
          toolCallId: 'call-1',
          output: alreadyFilled,
        }),
      ).toEqual({
        type: 'text',
        value:
          'Every requested slot already has a dish. To replace existing dishes, call fillSlots again with onlyEmpty: false (and use pinned for any slot you want to keep).',
      });

      const noneFit = {
        weekStart: WEEK,
        days: [],
        problems: [],
        applied: false,
        filled: 0,
        allSlotsAlreadyFilled: false,
      };
      expect(
        await toolDef.toModelOutput?.({
          input: request,
          toolCallId: 'call-1',
          output: noneFit,
        }),
      ).toEqual({
        type: 'text',
        value:
          'No dish fits these requests, so nothing changed. Relax the filters or omit candidateIds.',
      });
    });
  });

  describe('editPlanTool', () => {
    const operations = [
      {
        op: 'set' as const,
        day: Weekday.MON,
        section: MealSection.LUNCH,
        recipeIds: [recipe1],
      },
    ];

    it('saves operations and tells the model what changed', async () => {
      const toolDef = editPlanTool(mealPlan, userId, WEEK);
      const result = {
        weekStart: WEEK,
        days: [
          {
            day: Weekday.MON,
            sections: [
              {
                section: MealSection.LUNCH,
                recipes: [{ id: recipe1, title: 'Phở chay', tag: null }],
                previous: [],
              },
            ],
          },
        ],
        problems: [],
        applied: true,
        errors: [],
      };
      mealPlan.editPlan.mockResolvedValue(result);

      const output = await toolDef.execute?.({ operations }, execOptions);
      expect(mealPlan.editPlan).toHaveBeenCalledWith(userId, WEEK, operations);
      expect(output).toEqual(result);

      if (!output || Symbol.asyncIterator in output) {
        throw new Error('expected plan change output');
      }
      const modelOut = await toolDef.toModelOutput?.({
        input: { operations },
        toolCallId: 'call-1',
        output,
      });
      expect(modelOut).toEqual({
        type: 'text',
        value: expect.stringContaining(
          `Saved to the user's plan for the week of ${WEEK}`,
        ) as unknown,
      });
      expect(modelOut).toEqual({
        type: 'text',
        value: expect.stringContaining(
          `- Thứ Hai: trưa: Phở chay (id ${recipe1})`,
        ) as unknown,
      });
    });

    it('passes the week the model names', async () => {
      const toolDef = editPlanTool(mealPlan, userId, WEEK);
      mealPlan.editPlan.mockResolvedValue({
        weekStart: '2026-11-23',
        days: [],
        problems: [],
        applied: false,
        errors: [],
      });

      await toolDef.execute?.(
        { weekStart: '2026-11-23', operations },
        execOptions,
      );
      expect(mealPlan.editPlan).toHaveBeenCalledWith(
        userId,
        '2026-11-23',
        operations,
      );
    });

    it('says a same-day clash was saved with a warning', async () => {
      const toolDef = editPlanTool(mealPlan, userId, WEEK);
      const modelOut = await toolDef.toModelOutput?.({
        input: { operations },
        toolCallId: 'call-1',
        output: {
          weekStart: WEEK,
          days: [
            {
              day: Weekday.WED,
              sections: [
                {
                  section: MealSection.DINNER,
                  recipes: [
                    { id: 'rec-1', title: 'Đậu hũ', tag: null },
                    { id: 'rec-3', title: 'Rau bina', tag: null },
                  ],
                  previous: [{ id: 'rec-1', title: 'Đậu hũ', tag: null }],
                },
              ],
            },
          ],
          problems: [
            {
              code: 'DAY_CONFLICT',
              day: Weekday.WED,
              recipes: ['Đậu hũ', 'Rau bina'],
              recipeIds: ['rec-1', 'rec-3'],
              ingredients: ['Đậu hũ', 'Rau bina'],
              reason: 'Oxalat cản canxi',
            },
          ],
          applied: true,
          errors: [],
        },
      });
      expect(modelOut).toEqual({
        type: 'text',
        value: [
          `Saved to the user's plan for the week of ${WEEK}; the app shows the change in the chat and the user can rewind it. Changes:`,
          '- Thứ Tư: tối: Đậu hũ (id rec-1), Rau bina (id rec-3)',
          'Saved with same-day clash warnings (fix them unless the user wants them):',
          '- Thứ Tư: Đậu hũ and Rau bina must not be eaten in the same meal (Oxalat cản canxi); they come from: Đậu hũ, Rau bina.',
        ].join('\n'),
      });
    });

    it('says when no slot changed', async () => {
      const toolDef = editPlanTool(mealPlan, userId, WEEK);
      const modelOut = await toolDef.toModelOutput?.({
        input: { operations },
        toolCallId: 'call-1',
        output: {
          weekStart: WEEK,
          days: [],
          problems: [],
          applied: false,
          errors: ['remove: MON LUNCH does not have that dish'],
        },
      });
      expect(modelOut).toEqual({
        type: 'text',
        value:
          'No slot changed.\nNot applied:\n- remove: MON LUNCH does not have that dish',
      });
    });

    it('formats all problem types and unapplied operation errors when nothing was saved', async () => {
      const toolDef = editPlanTool(mealPlan, userId, WEEK);
      const result = {
        weekStart: WEEK,
        days: [],
        problems: [
          {
            code: 'UNKNOWN_RECIPE' as const,
            day: Weekday.MON,
            recipes: [],
            recipeIds: ['missing-id'],
            ingredients: [],
            reason: null,
          },
          {
            code: 'AVOIDED_INGREDIENT' as const,
            day: Weekday.TUE,
            recipes: ['Canh hành'],
            recipeIds: ['rec-2'],
            ingredients: ['Hành'],
            reason: null,
          },
          {
            code: 'DAY_CONFLICT' as const,
            day: Weekday.WED,
            recipes: ['Đậu hũ', 'Rau bina'],
            recipeIds: ['rec-1', 'rec-3'],
            ingredients: ['Đậu hũ', 'Rau bina'],
            reason: 'Oxalat cản canxi',
          },
          {
            code: 'DAY_CONFLICT' as const,
            day: Weekday.THU,
            recipes: ['Món A', 'Món B'],
            recipeIds: ['rec-4', 'rec-5'],
            ingredients: ['A', 'B'],
            reason: null,
          },
        ],
        applied: false,
        errors: ['move: MON LUNCH is full'],
      };
      mealPlan.editPlan.mockResolvedValue(result);

      const output = await toolDef.execute?.({ operations }, execOptions);
      if (!output || Symbol.asyncIterator in output) {
        throw new Error('expected plan change output');
      }
      const modelOut = await toolDef.toModelOutput?.({
        input: { operations },
        toolCallId: 'call-1',
        output,
      });
      expect(modelOut).toEqual({
        type: 'text',
        value: [
          'Nothing was saved. Fix these and call again:',
          '- Thứ Hai: a recipe id does not exist; use ids from searchRecipes.',
          '- Thứ Ba: "Canh hành" has Hành, which the user does not eat.',
          '- Thứ Tư: Đậu hũ and Rau bina must not be eaten in the same meal (Oxalat cản canxi); they come from: Đậu hũ, Rau bina.',
          '- Thứ Năm: A and B must not be eaten in the same meal (incompatible); they come from: Món A, Món B.',
          'Not applied:',
          '- move: MON LUNCH is full',
        ].join('\n'),
      });
    });
  });

  describe('autoBalancePlanTool & verifyMealPlanAllergiesTool', () => {
    it('delegates autoBalancePlan and summarizes target calories', async () => {
      const toolDef = autoBalancePlanTool(mealPlan, userId, WEEK);
      const balanced = {
        weekStart: WEEK,
        days: [
          {
            day: Weekday.MON,
            sections: [
              {
                section: MealSection.LUNCH,
                recipes: [
                  {
                    id: recipe1,
                    title: 'Cơm gạo lứt muối mè',
                    tag: RecipeTag.RICE,
                    caloriesPerServing: 430,
                  },
                ],
                previous: [],
              },
            ],
          },
        ],
        problems: [],
        applied: true,
        filled: 1,
        targetCalories: 2000,
      };
      mealPlan.autoBalancePlan.mockResolvedValue(balanced);

      const output = await toolDef.execute?.(
        { days: [Weekday.MON], targetCalories: 2000 },
        execOptions,
      );
      expect(mealPlan.autoBalancePlan).toHaveBeenCalledWith(userId, {
        weekStart: WEEK,
        days: [Weekday.MON],
        targetCalories: 2000,
      });

      if (!output || Symbol.asyncIterator in output) {
        throw new Error('expected balance output');
      }
      const modelOut = await toolDef.toModelOutput?.({
        input: {},
        toolCallId: 'call-balance',
        output,
      });
      expect(modelOut).toEqual({
        type: 'text',
        value: expect.stringContaining(
          "Auto-balanced against ~2000 kcal/day.\nSaved to the user's plan",
        ) as unknown,
      });

      const unchanged = await toolDef.toModelOutput?.({
        input: {},
        toolCallId: 'call-balance',
        output: { ...balanced, days: [], applied: false, filled: 0 },
      });
      expect(unchanged).toEqual({
        type: 'text',
        value:
          'The schedule already sits comfortably around ~2000 kcal/day, so no slot changed.',
      });
    });

    it('detects natural-language allergens via keyword + subagent audit and swaps flagged dishes', async () => {
      const safeId = 'd1a2d3e4-0000-4000-8000-000000000002';
      const mockModel = new MockLanguageModelV4({
        doGenerate: () =>
          Promise.resolve({
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  flagged: [
                    {
                      recipeId: recipe1,
                      reason: 'Món gỏi có đậu phộng rang gây dị ứng',
                    },
                  ],
                  summary:
                    'Phát hiện 1 món có đậu phộng và đã đổi sang món an toàn.',
                }),
              },
            ],
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: {
              inputTokens: {
                total: 10,
                noCache: 10,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: 10,
                text: 10,
                reasoning: undefined,
              },
            },
            warnings: [],
          }),
      });

      const savedPlan: MealPlanDto = {
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
      };
      const lunch = savedPlan.days[0].sections.find(
        ({ section }) => section === MealSection.LUNCH,
      );
      lunch?.recipes.push({
        id: recipe1,
        title: 'Gỏi ngó sen',
        imageUrl: null,
        tag: RecipeTag.SALAD,
        servings: 2,
        prepMinutes: 10,
        cookMinutes: 10,
        ingredients: [],
        steps: ['Trộn gỏi'],
      });
      const flaggedRef = {
        id: recipe1,
        title: 'Gỏi ngó sen',
        tag: RecipeTag.SALAD,
      };
      const removed = {
        weekStart: WEEK,
        days: [
          {
            day: Weekday.MON,
            sections: [
              {
                section: MealSection.LUNCH,
                recipes: [],
                previous: [flaggedRef],
              },
            ],
          },
        ],
        problems: [],
        applied: true,
        errors: [],
      };
      const replaced = {
        weekStart: WEEK,
        days: [
          {
            day: Weekday.MON,
            sections: [
              {
                section: MealSection.LUNCH,
                recipes: [
                  {
                    id: safeId,
                    title: 'Canh bí đao hạt sen',
                    tag: RecipeTag.SOUP,
                  },
                ],
                previous: [],
              },
            ],
          },
        ],
        problems: [],
        applied: true,
        filled: 1,
        allSlotsAlreadyFilled: false,
      };
      mealPlan.find.mockResolvedValue(savedPlan);
      mealPlan.recipeInstructions.mockResolvedValue({
        id: recipe1,
        title: 'Gỏi ngó sen',
        description: null,
        servings: 2,
        minutes: 20,
        ingredients: [
          { name: 'Đậu phộng', quantity: 25, unit: 'g', note: null },
        ],
        steps: ['Trộn gỏi và rắc đậu phộng'],
        avoidedIngredients: [],
      });
      mealPlan.editPlan.mockResolvedValue(removed);
      mealPlan.fillPlan.mockResolvedValue(replaced);

      const toolDef = verifyMealPlanAllergiesTool(
        mockModel,
        mealPlan,
        userId,
        WEEK,
        {
          ingredients: [],
          groups: [],
          allergyNote: 'Dị ứng đậu phộng nặng',
        },
      );

      const output = await toolDef.execute?.({}, execOptions);
      if (!output || Symbol.asyncIterator in output) {
        throw new Error('expected allergy verification output');
      }
      expect(output.verified).toBe(true);
      expect(output.flaggedDishes).toHaveLength(1);
      expect(output.flaggedDishes[0].recipeId).toBe(recipe1);
      expect(mealPlan.editPlan).toHaveBeenCalledWith(userId, WEEK, [
        {
          op: 'remove',
          day: Weekday.MON,
          section: MealSection.LUNCH,
          recipeId: recipe1,
        },
      ]);
      expect(mealPlan.fillPlan).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          weekStart: WEEK,
          days: [Weekday.MON],
          sections: [MealSection.LUNCH],
          onlyEmpty: true,
          avoidIds: [recipe1],
        }),
      );
      expect(output.applied).toBe(true);
      expect(output.safe).toBe(true);
      // The removal and the refill are one change: a rewind puts back the
      // flagged dish, the state before the tool ran.
      const mondayLunch = output.days?.[0].sections[0];
      expect(mondayLunch?.recipes.map(({ id }) => id)).toEqual([safeId]);
      expect(mondayLunch?.previous.map(({ id }) => id)).toEqual([recipe1]);
    });

    it('only reports flagged dishes when asked not to replace them', async () => {
      const savedPlan = {
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
            recipes:
              day === Weekday.MON && section === MealSection.DINNER
                ? [
                    {
                      id: recipe1,
                      title: 'Canh hành',
                      imageUrl: null,
                      tag: RecipeTag.SOUP,
                      servings: 2,
                      prepMinutes: 10,
                      cookMinutes: 10,
                      ingredients: [],
                      steps: ['Nấu'],
                    },
                  ]
                : [],
          })),
        })),
        problems: [],
      };
      mealPlan.find.mockResolvedValue(savedPlan);
      mealPlan.recipeInstructions.mockResolvedValue({
        id: recipe1,
        title: 'Canh hành',
        description: null,
        servings: 2,
        minutes: 20,
        ingredients: [{ name: 'Hành', quantity: 1, unit: 'củ', note: null }],
        steps: ['Nấu canh'],
        avoidedIngredients: ['Hành'],
      });

      const toolDef = verifyMealPlanAllergiesTool(
        new MockLanguageModelV4(),
        mealPlan,
        userId,
        WEEK,
        { ingredients: [{ id: 'ing-1', name: 'Hành' }], groups: [] },
      );
      const output = await toolDef.execute?.(
        { replaceFlagged: false },
        execOptions,
      );
      if (!output || Symbol.asyncIterator in output) {
        throw new Error('expected allergy verification output');
      }

      expect(output.safe).toBe(false);
      expect(output.flaggedDishes).toEqual([
        {
          day: Weekday.MON,
          section: MealSection.DINNER,
          recipeId: recipe1,
          title: 'Canh hành',
          reason: 'Chứa thành phần tránh: Hành',
        },
      ]);
      expect(output.applied).toBeUndefined();
      expect(mealPlan.editPlan).not.toHaveBeenCalled();
      expect(mealPlan.fillPlan).not.toHaveBeenCalled();
    });
  });

  describe('askUserTool', () => {
    it('has no execute, so the turn ends on the question', () => {
      const toolDef = askUserTool();
      expect(toolDef.execute).toBeUndefined();
      const schema = toolDef.inputSchema;
      if (!('safeParse' in schema)) throw new Error('expected a zod schema');
      expect(
        schema.safeParse({
          question: 'Bạn muốn đổi món nào?',
          options: ['Đậu hũ sốt cà', 'Canh nấm'],
        }).success,
      ).toBe(true);
      expect(
        schema.safeParse({ question: 'Đổi món?', options: ['Chỉ một'] })
          .success,
      ).toBe(false);
    });
  });

  describe('mergeChanges', () => {
    const ref = (id: string) => ({ id, title: id, tag: null });
    const change = (
      day: Weekday,
      previous: string[],
      recipes: string[],
      applied = true,
    ) => ({
      weekStart: WEEK,
      days: [
        {
          day,
          sections: [
            {
              section: MealSection.LUNCH,
              previous: previous.map(ref),
              recipes: recipes.map(ref),
            },
          ],
        },
      ],
      problems: [],
      applied,
    });

    it('keeps the dishes from before the first change and after the second', () => {
      const merged = mergeChanges(
        change(Weekday.MON, ['a'], []),
        change(Weekday.MON, [], ['b']),
      );
      const lunch = merged.days[0].sections[0];
      expect(merged.applied).toBe(true);
      expect(lunch.previous.map(({ id }) => id)).toEqual(['a']);
      expect(lunch.recipes.map(({ id }) => id)).toEqual(['b']);
    });

    it('adds the days only the second change touched and ignores one not saved', () => {
      const merged = mergeChanges(
        change(Weekday.MON, ['a'], []),
        change(Weekday.TUE, [], ['b']),
      );
      expect(merged.days.map(({ day }) => day)).toEqual([
        Weekday.MON,
        Weekday.TUE,
      ]);

      const first = change(Weekday.MON, ['a'], []);
      expect(mergeChanges(first, change(Weekday.TUE, [], ['b'], false))).toBe(
        first,
      );
    });

    it('says nothing was saved for a change that was not applied', () => {
      expect(changeFeedback(change(Weekday.MON, [], [], false))).toBe(
        'No slot changed.',
      );
    });
  });
});
