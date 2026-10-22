import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import type { MealPlanDto } from '../src/meal-plan/dto/meal-plan.dto';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const RECIPE_ID = 'd1a2d3e4-0000-4000-8000-000000000001';
const TOFU_ID = 'a1a2d3e4-0000-4000-8000-000000000001';

const recipe = {
  id: RECIPE_ID,
  title: 'Đậu hũ sốt cà',
  servings: 2,
  prepMinutes: 10,
  cookMinutes: null,
  steps: ['Chiên đậu'],
  ingredients: [
    {
      ingredientId: TOFU_ID,
      quantity: null,
      unit: null,
      note: null,
      ingredient: { name: 'Đậu hũ' },
    },
  ],
};
const body = {
  days: [
    { day: 'MON', breakfast: [], lunch: [RECIPE_ID], dinner: [], others: [] },
  ],
};

describe('Meal plan (e2e)', () => {
  const prisma = mockDeep<PrismaService>();
  let app: INestApplication<App>;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    token = await app.get(JwtService).signAsync({
      sub: USER_ID,
      username: 'vedora.user',
    });
  });

  beforeEach(() => {
    mockReset(prisma);
    prisma.$transaction.mockImplementation((run: unknown) =>
      (run as (tx: PrismaService) => Promise<unknown>)(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([{ id: USER_ID }]);
    prisma.user.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      accountVersion: 0,
      id: USER_ID,
      username: 'vedora.user',
      role: UserRole.USER,
    } as never);
    prisma.mealPlanEntry.findMany.mockResolvedValue([]);
    prisma.recipe.findMany.mockResolvedValue([recipe] as never);
    prisma.userAvoidedIngredient.findMany.mockResolvedValue([]);
    prisma.ingredientGroupMember.findMany.mockResolvedValue([]);
    prisma.incompatibilityRule.findMany.mockResolvedValue([]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires a signed-in user', async () => {
    await request(app.getHttpServer()).get('/api/v1/meal-plan').expect(401);
  });

  it('returns the saved timetable', async () => {
    prisma.mealPlanEntry.findMany.mockResolvedValue([
      { day: 'MON', section: 'LUNCH', recipe },
    ] as never);

    const response = await request(app.getHttpServer())
      .get('/api/v1/meal-plan')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = response.body as MealPlanDto;
    expect(body.days).toHaveLength(7);
    expect(body.days[0].sections[1]).toMatchObject({
      section: 'LUNCH',
      recipes: [{ title: 'Đậu hũ sốt cà' }],
    });
    expect(body.problems).toEqual([]);
  });

  it('saves a valid change', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/meal-plan/days')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(200);

    expect(prisma.mealPlanEntry.createMany).toHaveBeenCalled();
  });

  it('previews a manually selected recipe without saving', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/meal-plan/preview')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(200);
    expect(response.body).toMatchObject({
      days: [
        {
          day: 'MON',
          sections: [
            { section: 'BREAKFAST' },
            {
              section: 'LUNCH',
              recipes: [{ id: RECIPE_ID }],
              previous: [],
            },
            { section: 'DINNER' },
            { section: 'OTHER' },
          ],
        },
      ],
      problems: [],
    });
    expect(prisma.mealPlanEntry.createMany).not.toHaveBeenCalled();
    expect(prisma.mealPlanEntry.deleteMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('requires login and validates the manual preview body', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/meal-plan/preview')
      .send(body)
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/meal-plan/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ days: [] })
      .expect(400);
  });

  it('answers 409 for a recipe with an avoided ingredient', async () => {
    prisma.userAvoidedIngredient.findMany.mockResolvedValue([
      { ingredientId: TOFU_ID },
    ] as never);

    const response = await request(app.getHttpServer())
      .put('/api/v1/meal-plan/days')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(409);

    expect(response.body).toMatchObject({
      code: 'MEAL_PLAN_INVALID',
      problems: [
        {
          code: 'AVOIDED_INGREDIENT',
          day: 'MON',
          recipes: ['Đậu hũ sốt cà'],
          recipeIds: [RECIPE_ID],
          ingredients: ['Đậu hũ'],
        },
      ],
    });
    expect(prisma.mealPlanEntry.createMany).not.toHaveBeenCalled();
  });

  it('rejects an unknown weekday', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/meal-plan/days')
      .set('Authorization', `Bearer ${token}`)
      .send({
        days: [
          { day: 'FUNDAY', breakfast: [], lunch: [], dinner: [], others: [] },
        ],
      })
      .expect(400);
  });

  it('returns missing recipe IDs in preview and save errors', async () => {
    prisma.recipe.findMany.mockResolvedValue([]);
    for (const method of ['post', 'put'] as const) {
      const response = await request(app.getHttpServer())
        [method](`/api/v1/meal-plan/${method === 'post' ? 'preview' : 'days'}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(method === 'post' ? 200 : 409);
      expect((response.body as { problems: unknown }).problems).toEqual([
        {
          code: 'UNKNOWN_RECIPE',
          day: 'MON',
          recipes: [],
          recipeIds: [RECIPE_ID],
          ingredients: [],
          reason: null,
        },
      ]);
    }
    expect(prisma.mealPlanEntry.createMany).not.toHaveBeenCalled();
  });

  it('returns 409 instead of 500 for a database write conflict', async () => {
    prisma.mealPlanEntry.createMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '6.12.0',
      }),
    );
    const response = await request(app.getHttpServer())
      .put('/api/v1/meal-plan/days')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(409);
    expect((response.body as { code: string }).code).toBe('MEAL_PLAN_CONFLICT');
  });
});
