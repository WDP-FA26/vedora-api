import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { MealPlanService } from '../../../src/meal-plan/meal-plan.service.js';
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
        },
        {
          id: 'rec-2',
          title: 'Canh nấm',
          tag: null,
          minutes: null,
          ingredients: ['Nấm'],
          description: null,
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
          'rec-1 | Đậu hũ sốt cà | STIR_FRY | 15 phút | Đậu hũ, Cà chua | Món mặn đậm đà\nrec-2 | Canh nấm | chưa phân loại | ? phút | Nấm',
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
    const request = {
      days: [Weekday.MON],
      sections: [MealSection.LUNCH],
      onlyEmpty: true,
      maxMinutes: 30,
    };
    const section = (recipes: { id: string; title: string; tag: null }[]) => ({
      section: MealSection.LUNCH,
      recipes,
      previous: [],
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
});
