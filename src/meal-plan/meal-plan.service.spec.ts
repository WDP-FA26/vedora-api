import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import { DietaryService } from '../recipes/dietary.service';
import { IncompatibilityRulesService } from '../recipes/incompatibility-rules.service';
import { MealPlanService } from './meal-plan.service';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const TOFU_ID = 'a1a2d3e4-0000-4000-8000-000000000001';
const SPINACH_ID = 'a1a2d3e4-0000-4000-8000-000000000002';
const RICE_ID = 'a1a2d3e4-0000-4000-8000-000000000003';

function recipe(id: string, title: string, ingredients: [string, string][]) {
  return {
    id,
    title,
    servings: 2,
    prepMinutes: 10,
    cookMinutes: 5,
    steps: ['Nấu'],
    ingredients: ingredients.map(([ingredientId, name]) => ({
      ingredientId,
      quantity: null,
      unit: null,
      note: null,
      ingredient: { name },
    })),
  };
}

const tofuDish = recipe(
  'd1a2d3e4-0000-4000-8000-000000000001',
  'Đậu hũ sốt cà',
  [[TOFU_ID, 'Đậu hũ']],
);
const spinachSoup = recipe(
  'd1a2d3e4-0000-4000-8000-000000000002',
  'Canh rau bina',
  [[SPINACH_ID, 'Rau bina']],
);
const rice = recipe('d1a2d3e4-0000-4000-8000-000000000003', 'Cơm gạo lứt', [
  [RICE_ID, 'Gạo lứt'],
]);
const rule = {
  id: 'c1a2d3e4-0000-4000-8000-000000000001',
  aIngredientId: TOFU_ID,
  aGroupId: null,
  bIngredientId: SPINACH_ID,
  bGroupId: null,
  reason: 'Oxalat cản hấp thu canxi',
  source: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('MealPlanService', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: MealPlanService;

  function saved(...meals: { day: string; section: string; recipe: object }[]) {
    prisma.mealPlanEntry.findMany.mockResolvedValue(meals as never);
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    prisma.$transaction.mockImplementation((run: unknown) =>
      (run as (tx: PrismaService) => Promise<unknown>)(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([{ id: USER_ID }]);
    service = new MealPlanService(
      prisma,
      new DietaryService(prisma),
      new IncompatibilityRulesService(prisma),
    );
    saved();
    prisma.recipe.findMany.mockResolvedValue([
      tofuDish,
      spinachSoup,
      rice,
    ] as never);
    prisma.userAvoidedIngredient.findMany.mockResolvedValue([]);
    prisma.ingredientGroupMember.findMany.mockResolvedValue([]);
    prisma.incompatibilityRule.findMany.mockResolvedValue([rule]);
  });

  it('rejects incompatible ingredients in two sections of one day', async () => {
    const { problems } = await service.preview(USER_ID, [
      {
        day: 'MON',
        breakfast: [],
        lunch: [tofuDish.id],
        dinner: [],
        others: [spinachSoup.id],
      },
    ]);

    expect(problems).toEqual([
      {
        code: 'DAY_CONFLICT',
        day: 'MON',
        recipes: ['Đậu hũ sốt cà', 'Canh rau bina'],
        recipeIds: [tofuDish.id, spinachSoup.id],
        ingredients: ['Đậu hũ', 'Rau bina'],
        reason: 'Oxalat cản hấp thu canxi',
      },
    ]);
  });

  it('allows incompatible ingredients on different days', async () => {
    const { problems, days } = await service.preview(USER_ID, [
      {
        day: 'MON',
        breakfast: [],
        lunch: [tofuDish.id],
        dinner: [],
        others: [],
      },
      {
        day: 'TUE',
        breakfast: [],
        lunch: [spinachSoup.id],
        dinner: [],
        others: [],
      },
    ]);

    expect(problems).toEqual([]);
    expect(days).toHaveLength(2);
  });

  it('rejects a recipe with an ingredient the user avoids', async () => {
    prisma.userAvoidedIngredient.findMany.mockResolvedValue([
      { ingredientId: TOFU_ID },
    ] as never);

    const { problems } = await service.preview(USER_ID, [
      {
        day: 'WED',
        breakfast: [rice.id],
        lunch: [],
        dinner: [tofuDish.id],
        others: [],
      },
    ]);

    expect(problems).toEqual([
      expect.objectContaining({
        code: 'AVOIDED_INGREDIENT',
        day: 'WED',
        recipes: ['Đậu hũ sốt cà'],
        recipeIds: [tofuDish.id],
        ingredients: ['Đậu hũ'],
      }),
    ]);
  });

  it('lets a dish be removed from a day that already clashes', async () => {
    saved(
      { day: 'MON', section: 'LUNCH', recipe: tofuDish },
      { day: 'MON', section: 'DINNER', recipe: spinachSoup },
      { day: 'MON', section: 'OTHER', recipe: rice },
    );

    const { problems, days } = await service.preview(USER_ID, [
      {
        day: 'MON',
        breakfast: [],
        lunch: [tofuDish.id],
        dinner: [],
        others: [spinachSoup.id],
      },
    ]);

    expect(problems).toEqual([]);
    expect(days[0].sections.map(({ previous }) => previous.length)).toEqual([
      0, 1, 1, 1,
    ]);
  });

  it('reports a recipe that does not exist', async () => {
    prisma.recipe.findMany.mockResolvedValue([]);

    const { problems } = await service.preview(USER_ID, [
      {
        day: 'MON',
        breakfast: [rice.id],
        lunch: [rice.id, tofuDish.id],
        dinner: [],
        others: [],
      },
    ]);

    expect(problems).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_RECIPE',
        day: 'MON',
        recipes: [],
        recipeIds: [rice.id, tofuDish.id],
      }),
    ]);
  });

  it('saves nothing when a day is invalid', async () => {
    await expect(
      service.apply(USER_ID, [
        {
          day: 'MON',
          breakfast: [],
          lunch: [tofuDish.id],
          dinner: [],
          others: [spinachSoup.id],
        },
      ]),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.mealPlanEntry.deleteMany).not.toHaveBeenCalled();
    expect(prisma.mealPlanEntry.createMany).not.toHaveBeenCalled();
  });

  it.each(['P2002', 'P2003', 'P2034'])(
    'returns a retryable conflict for %s',
    async (code) => {
      prisma.mealPlanEntry.createMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('conflict', {
          code,
          clientVersion: '6.12.0',
        }),
      );
      await expect(
        service.apply(USER_ID, [
          {
            day: 'MON',
            breakfast: [],
            lunch: [rice.id],
            dinner: [],
            others: [],
          },
        ]),
      ).rejects.toMatchObject({
        response: { statusCode: 409, code: 'MEAL_PLAN_CONFLICT' },
      });
    },
  );

  it('replaces the listed days only, keeping the order', async () => {
    await service.apply(USER_ID, [
      {
        day: 'MON',
        breakfast: [],
        lunch: [rice.id, tofuDish.id],
        dinner: [],
        others: [],
      },
      { day: 'TUE', breakfast: [], lunch: [], dinner: [], others: [] },
    ]);

    expect(prisma.mealPlanEntry.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, day: { in: ['MON', 'TUE'] } },
    });
    expect(prisma.mealPlanEntry.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId: USER_ID,
          day: 'MON',
          section: 'LUNCH',
          recipeId: rice.id,
          position: 0,
        },
        {
          userId: USER_ID,
          day: 'MON',
          section: 'LUNCH',
          recipeId: tofuDish.id,
          position: 1,
        },
      ],
    });
  });
});
