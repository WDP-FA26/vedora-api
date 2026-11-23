import { MockLanguageModelV4 } from 'ai/test';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { MealPlanService } from '../../../src/meal-plan/meal-plan.service.js';
import { verifyMealPlanAllergiesTool } from '../../../src/meal-plan/tools/allergy-verifier-subagent.tool.js';
import { autoBalanceDraftTool } from '../../../src/meal-plan/tools/auto-balance-draft.tool.js';
import { editDraftTool } from '../../../src/meal-plan/tools/edit-draft.tool.js';
import { fillSlotsTool } from '../../../src/meal-plan/tools/fill-slots.tool.js';
import { getPlanTool } from '../../../src/meal-plan/tools/get-plan.tool.js';
import { getRecipeTool } from '../../../src/meal-plan/tools/get-recipe.tool.js';
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
    it('formats the saved weekly plan and unsaved draft changes', async () => {
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
      const draft = {
        weekStart: WEEK,
        days: [
          {
            day: Weekday.WED,
            sections: [
              {
                section: MealSection.LUNCH,
                recipes: [
                  { id: 'rec-pho', title: 'Phở chay', tag: RecipeTag.NOODLES },
                ],
                previous: [],
              },
            ],
          },
        ],
        problems: [],
        ok: true,
      };
      mealPlan.find.mockResolvedValue(savedPlan);
      mealPlan.getDraft.mockResolvedValue(draft);

      const output = await toolDef.execute?.({}, execOptions);
      expect(mealPlan.find).toHaveBeenCalledWith(userId, WEEK);
      expect(mealPlan.getDraft).toHaveBeenCalledWith(userId, WEEK);
      expect(output).toEqual({ plan: savedPlan, draft });

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
        value: expect.stringContaining(
          '- Thứ Tư: trưa: Phở chay (id rec-pho)',
        ) as unknown,
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
        ok: false,
        filled: 0,
        allSlotsAlreadyFilled: false,
      };
      mealPlan.fillDraft.mockResolvedValue(result);

      await toolDef.execute?.(
        { ...request, days: [Weekday.FRI], weekStart: '2026-11-23' },
        execOptions,
      );
      expect(mealPlan.fillDraft).toHaveBeenLastCalledWith(userId, {
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

    it('passes the request to fillDraft and summarizes the draft', async () => {
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
        ok: true,
        filled: 1,
        allSlotsAlreadyFilled: false,
      };
      mealPlan.fillDraft.mockResolvedValue(result);

      const output = await toolDef.execute?.(request, execOptions);
      expect(mealPlan.fillDraft).toHaveBeenCalledWith(userId, {
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
        value: expect.stringContaining('Cơm gạo lứt (id rec-1)') as unknown,
      });
    });

    it('reports when slots are already filled or when no dish matches', async () => {
      const toolDef = fillSlotsTool(mealPlan, userId, WEEK);

      const alreadyFilled = {
        weekStart: WEEK,
        days: [],
        problems: [],
        ok: false,
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
        ok: false,
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

  describe('editDraftTool', () => {
    const operations = [
      {
        op: 'set' as const,
        day: Weekday.MON,
        section: MealSection.LUNCH,
        recipeIds: [recipe1],
      },
    ];

    it('applies operations and shows unsaved draft feedback when valid', async () => {
      const toolDef = editDraftTool(mealPlan, userId, WEEK);
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
        ok: true,
        errors: [],
      };
      mealPlan.editDraft.mockResolvedValue(result);

      const output = await toolDef.execute?.({ operations }, execOptions);
      expect(mealPlan.editDraft).toHaveBeenCalledWith(userId, WEEK, operations);
      expect(output).toEqual(result);

      if (!output || Symbol.asyncIterator in output) {
        throw new Error('expected draft output');
      }
      const modelOut = await toolDef.toModelOutput?.({
        input: { operations },
        toolCallId: 'call-1',
        output,
      });
      expect(modelOut).toEqual({
        type: 'text',
        value: expect.stringContaining('Phở chay (id ') as unknown,
      });
    });

    it('formats all problem types and unapplied operation errors when invalid', async () => {
      const toolDef = editDraftTool(mealPlan, userId, WEEK);
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
        ok: false,
        errors: ['move: MON LUNCH is full'],
      };
      mealPlan.editDraft.mockResolvedValue(result);

      const output = await toolDef.execute?.({ operations }, execOptions);
      if (!output || Symbol.asyncIterator in output) {
        throw new Error('expected draft output');
      }
      const modelOut = await toolDef.toModelOutput?.({
        input: { operations },
        toolCallId: 'call-1',
        output,
      });
      expect(modelOut).toEqual({
        type: 'text',
        value: [
          'Nothing was kept. Fix these and call again:',
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

  describe('autoBalanceDraftTool & verifyMealPlanAllergiesTool', () => {
    it('delegates autoBalanceDraft and summarizes target calories', async () => {
      const toolDef = autoBalanceDraftTool(mealPlan, userId, WEEK);
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
        ok: true,
        filled: 1,
        targetCalories: 2000,
      };
      mealPlan.autoBalanceDraft.mockResolvedValue(balanced);

      const output = await toolDef.execute?.(
        { days: [Weekday.MON], targetCalories: 2000 },
        execOptions,
      );
      expect(mealPlan.autoBalanceDraft).toHaveBeenCalledWith(userId, {
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
        value: expect.stringContaining('~2000 kcal/day') as unknown,
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
                  summary: 'Phát hiện 1 món có đậu phộng và đã đổi sang món an toàn.',
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
            recipes: [],
          })),
        })),
        problems: [],
      };
      const draft = {
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
                    title: 'Gỏi ngó sen',
                    tag: RecipeTag.SALAD,
                  },
                ],
                previous: [],
              },
            ],
          },
        ],
        problems: [],
        ok: true,
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
        ok: true,
        filled: 1,
        allSlotsAlreadyFilled: false,
      };
      mealPlan.find.mockResolvedValue(savedPlan);
      mealPlan.getDraft.mockResolvedValue(draft);
      mealPlan.recipeInstructions.mockResolvedValue({
        id: recipe1,
        title: 'Gỏi ngó sen',
        description: null,
        servings: 2,
        minutes: 20,
        ingredients: [{ name: 'Đậu phộng', quantity: 25, unit: 'g', note: null }],
        steps: ['Trộn gỏi và rắc đậu phộng'],
        avoidedIngredients: [],
      });
      mealPlan.editDraft.mockResolvedValue({
        weekStart: WEEK,
        days: [],
        problems: [],
        ok: true,
        errors: [],
      });
      mealPlan.fillDraft.mockResolvedValue(replaced);

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
      expect(mealPlan.editDraft).toHaveBeenCalledWith(userId, WEEK, [
        {
          op: 'remove',
          day: Weekday.MON,
          section: MealSection.LUNCH,
          recipeId: recipe1,
        },
      ]);
      expect(mealPlan.fillDraft).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          weekStart: WEEK,
          days: [Weekday.MON],
          sections: [MealSection.LUNCH],
          onlyEmpty: true,
          avoidIds: [recipe1],
        }),
      );
      expect(output.ok).toBe(true);
      expect(output.days?.[0].sections[0].recipes[0].id).toBe(safeId);
    });
  });
});
