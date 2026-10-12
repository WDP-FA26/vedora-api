import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PostStatus, Prisma, PrismaClient } from '@prisma/client';
import { RecipeCatalogQueryDto } from '../src/recipes/dto/recipe-catalog.dto';
import { IncompatibilityRulesService } from '../src/recipes/incompatibility-rules.service';
import { RecipeCatalogService } from '../src/recipes/recipe-catalog.service';
import { MealPlanService } from '../src/meal-plan/meal-plan.service';
import { DietaryService } from '../src/recipes/dietary.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { confirmedDietaryProfile, verifiedIngredientSafety } from './fixtures/dietary';

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
    catalog = new RecipeCatalogService(db, rules, new DietaryService(db));
    plan = new MealPlanService(db, new DietaryService(db), rules);
    ({ id: userId } = await prisma.user.create({
      data: {
        username: 'catalog.user',
        fullName: 'Catalog User',
        email: 'catalog@example.test',
        emailVerifiedAt: new Date(),
        ...confirmedDietaryProfile,
      },
    }));
    ({ id: tofuId } = await prisma.ingredient.create({
      data: { name: 'Đậu hũ', aliases: ['ĐẬU PHỤ'], ...verifiedIngredientSafety },
    }));
    ({ id: spinachId } = await prisma.ingredient.create({
      data: { name: 'Rau bina', aliases: [], ...verifiedIngredientSafety },
    }));
    ({ id: riceId } = await prisma.ingredient.create({
      data: { name: 'Gạo lứt', aliases: [], ...verifiedIngredientSafety },
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
        ...confirmedDietaryProfile,
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
});
