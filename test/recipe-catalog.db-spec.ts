import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PostStatus, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app.setup';
import { MealPlanController } from '../src/meal-plan/meal-plan.controller';
import { MealPlannerChatService } from '../src/meal-plan/meal-planner-chat.service';
import { UserThrottlerGuard } from '../src/nutrition-chat/user-throttler.guard';
import type {
  MealPlanDto,
  SaveMealDayDto,
} from '../src/meal-plan/dto/meal-plan.dto';
import { RecipeCatalogQueryDto } from '../src/recipes/dto/recipe-catalog.dto';
import { IncompatibilityRulesService } from '../src/recipes/incompatibility-rules.service';
import { RecipeCatalogService } from '../src/recipes/recipe-catalog.service';
import { MealPlanService } from '../src/meal-plan/meal-plan.service';
import { DietaryService } from '../src/recipes/dietary.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Recipe catalog with PostgreSQL', () => {
  const schema = `vedora_catalog_test_${randomUUID().replaceAll('-', '')}`;
  let prisma: PrismaClient;
  let catalog: RecipeCatalogService;
  let plan: MealPlanService;
  let userId: string;
  let tofuId: string;
  let spinachId: string;
  let riceId: string;
  let soyGroupId: string;
  let greensGroupId: string;
  let tofuRecipeId: string;
  let spinachRecipeId: string;
  let riceRecipeId: string;
  let conflictRecipeId: string;
  let partialRecipeId: string;
  let unknownRecipeId: string;
  let zeroRecipeId: string;
  let app: INestApplication<App>;
  let token: string;

  beforeAll(async () => {
    const base = process.env.TEST_DATABASE_URL;
    if (!base)
      throw new Error(
        'Set TEST_DATABASE_URL to a disposable PostgreSQL database for npm run test:db',
      );
    const url = new URL(base);
    url.searchParams.set('schema', schema);
    // Never load the developer's DATABASE_URL: only migrate the random schema
    // on the explicit test connection. Production data is never seeded/deleted.
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
      ],
      {
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: 'pipe',
        timeout: 45_000,
      },
    );
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    const db = prisma as PrismaService;
    const rules = new IncompatibilityRulesService(db);
    catalog = new RecipeCatalogService(db, rules);
    plan = new MealPlanService(db, new DietaryService(db), rules);
    ({ id: userId } = await prisma.user.create({
      data: {
        username: 'catalog.user',
        fullName: 'Catalog User',
        email: 'catalog@example.test',
        emailVerifiedAt: new Date(),
      },
    }));
    ({ id: tofuId } = await prisma.ingredient.create({
      data: { name: 'Đậu hũ', aliases: ['ĐẬU PHỤ'] },
    }));
    ({ id: spinachId } = await prisma.ingredient.create({
      data: { name: 'Rau bina', aliases: [] },
    }));
    ({ id: riceId } = await prisma.ingredient.create({
      data: { name: 'Gạo lứt', aliases: [] },
    }));
    ({ id: soyGroupId } = await prisma.ingredientGroup.create({
      data: { name: 'Đậu nành', members: { create: { ingredientId: tofuId } } },
    }));
    ({ id: greensGroupId } = await prisma.ingredientGroup.create({
      data: { name: 'Rau', members: { create: { ingredientId: spinachId } } },
    }));

    async function recipe(
      title: string,
      ingredientIds: string[],
      prepMinutes: number | null,
      cookMinutes: number | null,
    ) {
      const { id } = await prisma.recipe.create({
        data: {
          title,
          servings: 2,
          prepMinutes,
          cookMinutes,
          steps: ['Nấu'],
          ingredients: {
            create: ingredientIds.map((ingredientId, position) => ({
              ingredientId,
              position,
              quantity: 200,
              unit: 'g',
            })),
          },
        },
      });
      return id;
    }
    tofuRecipeId = await recipe('Đậu hũ sốt cà', [tofuId], 10, 5);
    spinachRecipeId = await recipe('Canh xanh', [spinachId], 5, 15);
    riceRecipeId = await recipe('Cơm gạo lứt', [riceId], 0, 10);
    conflictRecipeId = await recipe(
      'Canh đậu hũ rau bina',
      [tofuId, spinachId],
      5,
      5,
    );
    partialRecipeId = await recipe(
      'Món biết thời gian nấu',
      [riceId],
      null,
      10,
    );
    unknownRecipeId = await recipe(
      'Món chưa có thời gian',
      [riceId],
      null,
      null,
    );
    zeroRecipeId = await recipe('Món ăn ngay', [riceId], 0, 0);
    // Equal timestamps exercise the unique-id tie breaker.
    await prisma.recipe.updateMany({
      data: { updatedAt: new Date('2026-10-12T00:00:00Z') },
    });
    // Real HTTP controller, validation, JWT and PostgreSQL; no AI/provider calls.
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: 'meal-plan-database-test-secret' }),
      ],
      controllers: [MealPlanController],
      providers: [
        { provide: PrismaService, useValue: db },
        { provide: MealPlanService, useValue: plan },
        { provide: MealPlannerChatService, useValue: {} },
        {
          provide: ConfigService,
          useValue: new ConfigService({ API_PREFIX: 'api/v1' }),
        },
      ],
    })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    token = await app
      .get(JwtService)
      .signAsync({ sub: userId, username: 'catalog.user' });
  });

  beforeEach(async () => {
    await prisma.userAvoidedIngredient.deleteMany();
    await prisma.userAvoidedGroup.deleteMany();
    await prisma.incompatibilityRule.deleteMany();
    await prisma.mealPlanEntry.deleteMany();
    await prisma.recipe.updateMany({
      data: { postId: null, updatedAt: new Date('2026-10-12T00:00:00Z') },
    });
    await prisma.post.deleteMany();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await prisma.$executeRaw(
        Prisma.sql`DROP SCHEMA ${Prisma.raw(`"${schema}"`)} CASCADE`,
      );
      await prisma.$disconnect();
    }
  });

  function query(filters: Partial<RecipeCatalogQueryDto> = {}) {
    return Object.assign(new RecipeCatalogQueryDto(), filters);
  }

  async function suitableIds() {
    const page = await catalog.list(query({ suitableForMe: true }), userId);
    return page.items.map(({ id }) => id);
  }

  it('counts before paging and gives stable, distinct pages', async () => {
    const first = await catalog.list(query({ limit: 2 }));
    const second = await catalog.list(query({ page: 2, limit: 2 }));
    const repeated = await catalog.list(query({ limit: 2 }));
    expect(first.meta).toMatchObject({
      totalItems: 7,
      totalPages: 4,
      hasNextPage: true,
    });
    expect(first.items.map(({ id }) => id)).toEqual(
      repeated.items.map(({ id }) => id),
    );
    expect(
      second.items.every(
        ({ id }) => !first.items.some((item) => item.id === id),
      ),
    ).toBe(true);
    const empty = await catalog.list(query({ page: 10, limit: 2 }));
    expect(empty.items).toEqual([]);
    expect(empty.meta.totalItems).toBe(7);
  });

  it('searches ingredient names and aliases case-insensitively', async () => {
    const aliases = await catalog.list(query({ q: 'đậu phụ' }));
    expect(aliases.items.map(({ id }) => id).sort()).toEqual(
      [tofuRecipeId, conflictRecipeId].sort(),
    );
    const names = await catalog.list(query({ q: 'rau bina' }));
    expect(names.items.map(({ id }) => id).sort()).toEqual(
      [spinachRecipeId, conflictRecipeId].sort(),
    );
  });

  it('searches descriptions and treats SQL metacharacters as literal text', async () => {
    await prisma.recipe.update({
      where: { id: riceRecipeId },
      data: { description: '100%_ngon' },
    });
    expect(
      (await catalog.list(query({ q: '%_' }))).items.map(({ id }) => id),
    ).toEqual([riceRecipeId]);
    expect(
      (await catalog.list(query({ q: "' OR TRUE --" }))).meta.totalItems,
    ).toBe(0);
  });

  it('filters total time including the boundary and excludes unknown times', async () => {
    const page = await catalog.list(query({ maxMinutes: 15 }));
    expect(page.items.map(({ id }) => id).sort()).toEqual(
      [
        tofuRecipeId,
        riceRecipeId,
        conflictRecipeId,
        partialRecipeId,
        zeroRecipeId,
      ].sort(),
    );
    expect(page.meta.totalItems).toBe(5);
    expect(
      (await catalog.list(query({ maxMinutes: 0 }))).items.map(({ id }) => id),
    ).toEqual([zeroRecipeId]);
    expect((await catalog.findOne(unknownRecipeId)).totalMinutes).toBeNull();
    expect((await catalog.findOne(partialRecipeId)).totalMinutes).toBe(10);
  });

  it('filters avoided ingredients and whole groups only for the requesting user', async () => {
    await prisma.userAvoidedIngredient.create({
      data: { userId, ingredientId: riceId },
    });
    await prisma.userAvoidedGroup.create({
      data: { userId, groupId: soyGroupId },
    });
    expect(await suitableIds()).toEqual([spinachRecipeId]);
    expect((await catalog.list(query())).meta.totalItems).toBe(7);
    const other = await prisma.user.create({
      data: {
        username: 'other.user',
        fullName: 'Other',
        email: 'other@example.test',
      },
    });
    expect(
      (await catalog.list(query({ suitableForMe: true }), other.id)).meta
        .totalItems,
    ).toBe(7);
  });

  it.each(['ingredients', 'ingredient-group', 'groups'])(
    'excludes conflicts via %s before pagination',
    async (kind) => {
      await prisma.incompatibilityRule.create({
        data: {
          aIngredientId: kind === 'groups' ? null : tofuId,
          aGroupId: kind === 'groups' ? soyGroupId : null,
          bIngredientId: kind === 'ingredients' ? spinachId : null,
          bGroupId: kind === 'ingredients' ? null : greensGroupId,
          reason: 'Test conflict',
        },
      });
      const ids = await suitableIds();
      expect(ids).not.toContain(conflictRecipeId);
      expect(ids).toContain(tofuRecipeId);
      expect(ids).toContain(spinachRecipeId);
      const page = await catalog.list(
        query({ suitableForMe: true, limit: 2 }),
        userId,
      );
      expect(page.items).toHaveLength(2);
      expect(page.meta.totalItems).toBe(6);
    },
  );

  it('does not conflict an ingredient with itself in overlapping groups', async () => {
    await prisma.ingredientGroupMember.create({
      data: { groupId: greensGroupId, ingredientId: tofuId },
    });
    await prisma.incompatibilityRule.create({
      data: {
        aGroupId: greensGroupId,
        bGroupId: greensGroupId,
        reason: 'Test same group',
      },
    });
    expect(await suitableIds()).toContain(tofuRecipeId);
    expect(await suitableIds()).not.toContain(conflictRecipeId);
    await prisma.ingredientGroupMember.delete({
      where: {
        groupId_ingredientId: { groupId: greensGroupId, ingredientId: tofuId },
      },
    });
  });

  it('combines search, time and suitability in the count and rows', async () => {
    await prisma.userAvoidedIngredient.create({
      data: { userId, ingredientId: spinachId },
    });
    const page = await catalog.list(
      query({ q: 'đậu phụ', maxMinutes: 15, suitableForMe: true, limit: 1 }),
      userId,
    );
    expect(page.items.map(({ id }) => id)).toEqual([tofuRecipeId]);
    expect(page.meta.totalItems).toBe(1);
  });

  it('hides unpublished source posts and keeps admin-only fields out', async () => {
    const post = await prisma.post.create({
      data: { authorId: userId, status: PostStatus.PROCESSING },
    });
    await prisma.recipe.update({
      where: { id: tofuRecipeId },
      data: { postId: post.id },
    });
    expect((await catalog.findOne(tofuRecipeId)).post).toBeNull();
    expect(
      (await catalog.list(query({ q: 'sốt cà' }))).items[0].post,
    ).toBeNull();
    await prisma.post.update({
      where: { id: post.id },
      data: { status: PostStatus.PUBLISHED },
    });
    const detail = await catalog.findOne(tofuRecipeId);
    expect(detail.post).toMatchObject({
      id: post.id,
      author: { username: 'catalog.user' },
    });
    expect(detail.post).not.toHaveProperty('status');
    expect(detail).not.toHaveProperty('createdById');
  });

  it('lets a user preview and save a catalog recipe and rejects a conflicting day', async () => {
    await prisma.incompatibilityRule.create({
      data: {
        aIngredientId: tofuId,
        bIngredientId: spinachId,
        reason: 'Test conflict',
      },
    });
    const day = {
      day: 'MON' as const,
      breakfast: [],
      lunch: [tofuRecipeId],
      dinner: [],
      others: [],
    };
    expect((await plan.preview(userId, [day])).problems).toEqual([]);
    expect(await prisma.mealPlanEntry.count()).toBe(0);
    const saved = await plan.apply(userId, [day]);
    expect(saved.days[0].sections[1].recipes[0].id).toBe(tofuRecipeId);
    const invalid = { ...day, dinner: [spinachRecipeId] };
    expect((await plan.preview(userId, [invalid])).problems).toMatchObject([
      { code: 'DAY_CONFLICT' },
    ]);
    await expect(plan.apply(userId, [invalid])).rejects.toMatchObject({
      response: { code: 'MEAL_PLAN_INVALID' },
    });
    expect(await prisma.mealPlanEntry.count()).toBe(1);
  });

  const dayInput = (
    day: SaveMealDayDto['day'],
    lunch: string[],
  ): SaveMealDayDto => ({
    day,
    breakfast: [],
    lunch,
    dinner: [],
    others: [],
  });

  const saveHttp = (days: SaveMealDayDto[]) =>
    request(app.getHttpServer())
      .put('/api/v1/meal-plan/days')
      .set('Authorization', `Bearer ${token}`)
      .send({ days });

  const lunchIds = (body: MealPlanDto, day: string) =>
    body.days
      .find((item) => item.day === day)!
      .sections.find((item) => item.section === 'LUNCH')!
      .recipes.map(({ id }) => id);

  it('handles parallel PUT retries of the same dish without duplicate-key failures', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        saveHttp([dayInput('MON', [riceRecipeId])]),
      ),
    );
    expect(responses.map(({ status }) => status)).toEqual(Array(8).fill(200));
    expect(await prisma.mealPlanEntry.findMany()).toMatchObject([
      { day: 'MON', section: 'LUNCH', recipeId: riceRecipeId, position: 0 },
    ]);
    expect(await prisma.mealPlanEntry.count()).toBe(1);
  });

  it('replaces concurrent same-day payloads completely and returns each save, not a merged meal', async () => {
    const first = [
      tofuRecipeId,
      spinachRecipeId,
      riceRecipeId,
      conflictRecipeId,
      partialRecipeId,
      unknownRecipeId,
    ];
    const second = [zeroRecipeId];
    const responses = await Promise.all([
      saveHttp([dayInput('MON', first)]),
      saveHttp([dayInput('MON', second)]),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(lunchIds(responses[0].body as MealPlanDto, 'MON')).toEqual(first);
    expect(lunchIds(responses[1].body as MealPlanDto, 'MON')).toEqual(second);
    const rows = await prisma.mealPlanEntry.findMany({
      orderBy: { position: 'asc' },
    });
    expect([first, second]).toContainEqual(
      rows.map(({ recipeId }) => recipeId),
    );
    expect(rows.map(({ position }) => position)).toEqual(
      rows.map((_, index) => index),
    );
  });

  it('keeps both changes when parallel PUTs replace different days', async () => {
    const responses = await Promise.all([
      saveHttp([dayInput('MON', [riceRecipeId])]),
      saveHttp([dayInput('TUE', [tofuRecipeId])]),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    const saved = await plan.find(userId);
    expect(lunchIds(saved, 'MON')).toEqual([riceRecipeId]);
    expect(lunchIds(saved, 'TUE')).toEqual([tofuRecipeId]);
    expect(await prisma.mealPlanEntry.count()).toBe(2);
  });

  it('rolls back every requested day when one is invalid while another PUT succeeds', async () => {
    await plan.apply(userId, [dayInput('MON', [riceRecipeId])]);
    await prisma.userAvoidedIngredient.create({
      data: { userId, ingredientId: tofuId },
    });
    const responses = await Promise.all([
      saveHttp([dayInput('MON', []), dayInput('TUE', [tofuRecipeId])]),
      saveHttp([dayInput('WED', [spinachRecipeId])]),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([409, 200]);
    expect(responses[0].body).toMatchObject({
      code: 'MEAL_PLAN_INVALID',
      problems: [{ recipeIds: [tofuRecipeId], recipes: ['Đậu hũ sốt cà'] }],
    });
    const saved = await plan.find(userId);
    expect(lunchIds(saved, 'MON')).toEqual([riceRecipeId]);
    expect(lunchIds(saved, 'TUE')).toEqual([]);
    expect(lunchIds(saved, 'WED')).toEqual([spinachRecipeId]);
  });

  it('preserves removal-only repairs but checks existing dishes when a new one is added', async () => {
    await plan.apply(userId, [dayInput('MON', [tofuRecipeId, riceRecipeId])]);
    await prisma.userAvoidedIngredient.create({
      data: { userId, ingredientId: tofuId },
    });
    const rejected = await saveHttp([
      dayInput('MON', [tofuRecipeId, riceRecipeId, spinachRecipeId]),
    ]);
    expect(rejected.status).toBe(409);
    expect((rejected.body as { problems: unknown }).problems).toMatchObject([
      { recipeIds: [tofuRecipeId] },
    ]);
    const repaired = await saveHttp([dayInput('MON', [riceRecipeId])]);
    expect(repaired.status).toBe(200);
    expect(lunchIds(repaired.body as MealPlanDto, 'MON')).toEqual([
      riceRecipeId,
    ]);
  });
});
