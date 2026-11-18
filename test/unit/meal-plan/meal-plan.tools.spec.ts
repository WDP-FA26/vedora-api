import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { MealPlanService } from '../../../src/meal-plan/meal-plan.service.js';
import { generateMealPlanTool } from '../../../src/meal-plan/tools/generate-meal-plan.tool.js';
import { getRecipeTool } from '../../../src/meal-plan/tools/get-recipe.tool.js';
import { proposeMealPlanTool } from '../../../src/meal-plan/tools/propose-meal-plan.tool.js';
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
        },
        {
          id: 'rec-2',
          title: 'Canh nấm',
          tag: null,
          minutes: null,
          ingredients: ['Nấm'],
        },
      ];
      mealPlan.suggestions.mockResolvedValue(suggestions);

      const output = await toolDef.execute?.(
        { query: 'đậu hũ', tag: RecipeTag.STIR_FRY, maxMinutes: 30 },
        execOptions,
      );
      expect(mealPlan.suggestions).toHaveBeenCalledWith(userId, 'đậu hũ', {
        tag: RecipeTag.STIR_FRY,
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
          'rec-1 | Đậu hũ sốt cà | STIR_FRY | 15 phút | Đậu hũ, Cà chua\nrec-2 | Canh nấm | chưa phân loại | ? phút | Nấm',
      });
    });

    it('returns a clear message when no recipes match', async () => {
      const toolDef = searchRecipesTool(mealPlan, userId);
      mealPlan.suggestions.mockResolvedValue([]);

      const output = await toolDef.execute?.({}, execOptions);
      expect(mealPlan.suggestions).toHaveBeenCalledWith(userId, undefined, {
        tag: undefined,
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

  describe('proposeMealPlanTool', () => {
    const daysInput = [
      {
        day: Weekday.MON,
        breakfast: [],
        lunch: ['d1a2d3e4-0000-4000-8000-000000000001'],
        dinner: [],
        others: [],
      },
    ];

    it('returns ok=true and tells model the proposal is shown when there are no problems', async () => {
      const toolDef = proposeMealPlanTool(mealPlan, userId);
      const preview = { days: [], problems: [] };
      mealPlan.preview.mockResolvedValue(preview);

      const output = await toolDef.execute?.({ days: daysInput }, execOptions);
      expect(mealPlan.preview).toHaveBeenCalledWith(userId, daysInput);
      expect(output).toEqual({ ...preview, ok: true });

      if (!output || Symbol.asyncIterator in output) {
        throw new Error('expected proposal output');
      }
      const modelOut = await toolDef.toModelOutput?.({
        input: { days: daysInput },
        toolCallId: 'call-1',
        output,
      });
      expect(modelOut).toEqual({
        type: 'text',
        value:
          'The proposal is on screen, not saved. Ask the user to press "Áp dụng" or say what to change.',
      });
    });

    it('returns ok=false and formats all problem types for the model when invalid', async () => {
      const toolDef = proposeMealPlanTool(mealPlan, userId);
      const preview = {
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
      };
      mealPlan.preview.mockResolvedValue(preview);

      const output = await toolDef.execute?.({ days: daysInput }, execOptions);
      expect(output).toEqual({ ...preview, ok: false });

      if (!output || Symbol.asyncIterator in output) {
        throw new Error('expected proposal output');
      }
      const modelOut = await toolDef.toModelOutput?.({
        input: { days: daysInput },
        toolCallId: 'call-1',
        output,
      });
      expect(modelOut).toEqual({
        type: 'text',
        value: [
          'Not shown. Fix these and call again:',
          '- Thứ Hai: a recipeId does not exist; use ids from searchRecipes.',
          '- Thứ Ba: "Canh hành" has Hành, which the user does not eat.',
          '- Thứ Tư: Đậu hũ and Rau bina must not be eaten on the same day (Oxalat cản canxi); they come from: Đậu hũ, Rau bina.',
          '- Thứ Năm: A and B must not be eaten on the same day (incompatible); they come from: Món A, Món B.',
        ].join('\n'),
      });
    });
  });
  describe('generateMealPlanTool', () => {
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

    it('passes the request to the generator and marks a clean result ok', async () => {
      const toolDef = generateMealPlanTool(mealPlan, userId);
      const preview = {
        days: [
          {
            day: Weekday.MON,
            sections: [
              section([{ id: 'rec-1', title: 'Cơm gạo lứt', tag: null }]),
            ],
          },
        ],
        problems: [],
      };
      mealPlan.generate.mockResolvedValue(preview);

      const output = await toolDef.execute?.(request, execOptions);
      expect(mealPlan.generate).toHaveBeenCalledWith(userId, request);
      expect(output).toEqual({ ...preview, ok: true });

      const modelOut = await toolDef.toModelOutput?.({
        input: request,
        toolCallId: 'call-1',
        output: { ...preview, ok: true },
      });
      expect(modelOut).toEqual({
        type: 'text',
        value: expect.stringContaining('Cơm gạo lứt (id rec-1)') as unknown,
      });
    });

    it('is not ok when nothing fits, so no card is shown', async () => {
      const toolDef = generateMealPlanTool(mealPlan, userId);
      mealPlan.generate.mockResolvedValue({ days: [], problems: [] });

      const output = await toolDef.execute?.(request, execOptions);
      expect(output).toEqual({ days: [], problems: [], ok: false });
    });
  });
});
