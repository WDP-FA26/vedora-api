import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  type IngredientGroup,
  type IngredientGroupMember,
  type IncompatibilityRule,
  type MealPlanEntry,
  MealSection,
  PostStatus,
  type Recipe,
  type RecipeIngredient,
  type User,
  Weekday,
} from '../src/mongo/models';
import { MongoModule } from '../src/mongo/mongo.module';
import { MongoService } from '../src/mongo/mongo.service';
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
import { deleteWithReferences } from '../src/mongo/relations';
import {
  createIngredient,
  createPost,
  createRecipe,
  createUser,
} from './fixtures';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from './mongo-test-db';

describe('Recipe catalog with MongoDB', () => {
  let mongo: MongoService;
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

  const members = () =>
    mongo.connection.model<IngredientGroupMember>('IngredientGroupMember');
  const rulesModel = () =>
    mongo.connection.model<IncompatibilityRule>('IncompatibilityRule');
  const recipesModel = () => mongo.connection.model<Recipe>('Recipe');
  const usersModel = () => mongo.connection.model<User>('User');
  const entriesModel = () =>
    mongo.connection.model<MealPlanEntry>('MealPlanEntry');

  const addMember = (groupId: string, ingredientId: string) =>
    members().create({ _id: randomUUID(), groupId, ingredientId });
  const rule = (sides: {
    aIngredientId?: string | null;
    aGroupId?: string | null;
    bIngredientId?: string | null;
    bGroupId?: string | null;
  }) =>
    rulesModel().create({
      _id: randomUUID(),
      reason: 'Test conflict',
      ...sides,
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongoModule.forTest(createTestMongoUrl('catalog')),
        JwtModule.register({ secret: 'meal-plan-database-test-secret' }),
      ],
      controllers: [MealPlanController],
      providers: [
        IncompatibilityRulesService,
        DietaryService,
        MealPlanService,
        RecipeCatalogService,
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
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    catalog = app.get(RecipeCatalogService);
    plan = app.get(MealPlanService);
    ({ id: userId } = await createUser(mongo, {
      username: 'catalog.user',
      fullName: 'Catalog User',
      email: 'catalog@example.test',
    }));
    ({ id: tofuId } = await createIngredient(mongo, {
      name: 'Đậu hũ',
      aliases: ['ĐẬU PHỤ'],
    }));
    ({ id: spinachId } = await createIngredient(mongo, { name: 'Rau bina' }));
    ({ id: riceId } = await createIngredient(mongo, { name: 'Gạo lứt' }));
    const group = async (name: string, ingredientId: string) => {
      const { id } = await mongo.connection
        .model<IngredientGroup>('IngredientGroup')
        .create({ _id: randomUUID(), name, dietary: false });
      await addMember(id, ingredientId);
      return id;
    };
    soyGroupId = await group('Đậu nành', tofuId);
    greensGroupId = await group('Rau', spinachId);

    async function recipe(
      title: string,
      ingredientIds: string[],
      prepMinutes: number | null,
      cookMinutes: number | null,
    ) {
      const { id } = await createRecipe(mongo, {
        title,
        prepMinutes,
        cookMinutes,
        steps: ['Nấu'],
      });
      await mongo.connection
        .model<RecipeIngredient>('RecipeIngredient')
        .insertMany(
          ingredientIds.map((ingredientId, position) => ({
            _id: randomUUID(),
            recipeId: id,
            ingredientId,
            position,
            quantity: 200,
            unit: 'g',
          })),
        );
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
    await mongo.db
      .collection('recipes')
      .updateMany(
        {},
        { $set: { updatedAt: new Date('2026-10-12T00:00:00Z') } },
      );
    token = await app
      .get(JwtService)
      .signAsync({ sub: userId, username: 'catalog.user' });
  });

  beforeEach(async () => {
    const { db } = mongo;
    await db
      .collection('users')
      .updateMany(
        {},
        { $set: { avoidedIngredientIds: [], avoidedGroupIds: [] } },
      );
    await db.collection('incompatibility_rules').deleteMany({});
    await db.collection('meal_plan_entries').deleteMany({});
    await db
      .collection('recipes')
      .updateMany(
        {},
        { $set: { postId: null, updatedAt: new Date('2026-10-12T00:00:00Z') } },
      );
    await mongo.withTransaction((session) =>
      deleteWithReferences(db, session, 'posts', {}),
    );
  });

  afterAll(async () => {
    if (app) await dropTestDatabase(app);
    if (app) await app.close();
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
    await recipesModel().updateOne(
      { _id: riceRecipeId },
      { $set: { description: '100%_ngon' } },
    );
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
    await usersModel().updateOne(
      { _id: userId },
      {
        $set: {
          avoidedIngredientIds: [riceId],
          avoidedGroupIds: [soyGroupId],
        },
      },
    );
    expect(await suitableIds()).toEqual([spinachRecipeId]);
    expect((await catalog.list(query())).meta.totalItems).toBe(7);
    const other = await createUser(mongo, {
      username: 'other.user',
      fullName: 'Other',
      email: 'other@example.test',
    });
    expect(
      (await catalog.list(query({ suitableForMe: true }), other.id)).meta
        .totalItems,
    ).toBe(7);
  });

  it.each(['ingredients', 'ingredient-group', 'groups'])(
    'excludes conflicts via %s before pagination',
    async (kind) => {
      await rule({
        aIngredientId: kind === 'groups' ? null : tofuId,
        aGroupId: kind === 'groups' ? soyGroupId : null,
        bIngredientId: kind === 'ingredients' ? spinachId : null,
        bGroupId: kind === 'ingredients' ? null : greensGroupId,
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
    await addMember(greensGroupId, tofuId);
    await rule({ aGroupId: greensGroupId, bGroupId: greensGroupId });
    expect(await suitableIds()).toContain(tofuRecipeId);
    expect(await suitableIds()).not.toContain(conflictRecipeId);
    await members().deleteOne({
      groupId: greensGroupId,
      ingredientId: tofuId,
    });
  });

  it('combines search, time and suitability in the count and rows', async () => {
    await usersModel().updateOne(
      { _id: userId },
      { $set: { avoidedIngredientIds: [spinachId] } },
    );
    const page = await catalog.list(
      query({ q: 'đậu phụ', maxMinutes: 15, suitableForMe: true, limit: 1 }),
      userId,
    );
    expect(page.items.map(({ id }) => id)).toEqual([tofuRecipeId]);
    expect(page.meta.totalItems).toBe(1);
  });

  it('hides unpublished source posts and keeps admin-only fields out', async () => {
    const post = await createPost(mongo, {
      authorId: userId,
      status: PostStatus.PROCESSING,
      publishedAt: null,
    });
    await recipesModel().updateOne(
      { _id: tofuRecipeId },
      { $set: { postId: post.id } },
    );
    expect((await catalog.findOne(tofuRecipeId)).post).toBeNull();
    expect(
      (await catalog.list(query({ q: 'sốt cà' }))).items[0].post,
    ).toBeNull();
    await mongo.connection
      .model('Post')
      .updateOne({ _id: post.id }, { $set: { status: PostStatus.PUBLISHED } });
    const detail = await catalog.findOne(tofuRecipeId);
    expect(detail.post).toMatchObject({
      id: post.id,
      author: { username: 'catalog.user' },
    });
    expect(detail.post).not.toHaveProperty('status');
    expect(detail).not.toHaveProperty('createdById');
  });

  it('lets a user preview and save a catalog recipe and rejects a conflicting day', async () => {
    await rule({ aIngredientId: tofuId, bIngredientId: spinachId });
    const day = {
      day: Weekday.MON,
      breakfast: [],
      lunch: [tofuRecipeId],
      dinner: [],
      others: [],
    };
    expect((await plan.preview(userId, [day])).problems).toEqual([]);
    expect(await entriesModel().countDocuments()).toBe(0);
    const saved = await plan.apply(userId, [day]);
    expect(saved.days[0].sections[1].recipes[0].id).toBe(tofuRecipeId);
    const invalid = { ...day, dinner: [spinachRecipeId] };
    expect((await plan.preview(userId, [invalid])).problems).toMatchObject([
      { code: 'DAY_CONFLICT' },
    ]);
    await expect(plan.apply(userId, [invalid])).rejects.toMatchObject({
      response: { code: 'MEAL_PLAN_INVALID' },
    });
    expect(await entriesModel().countDocuments()).toBe(1);
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

  const lunchIds = (body: MealPlanDto, day: Weekday) =>
    body.days
      .find((item) => item.day === day)!
      .sections.find((item) => item.section === MealSection.LUNCH)!
      .recipes.map(({ id }) => id);

  it('handles parallel PUT retries of the same dish without duplicate-key failures', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        saveHttp([dayInput(Weekday.MON, [riceRecipeId])]),
      ),
    );
    expect(responses.map(({ status }) => status)).toEqual(Array(8).fill(200));
    expect(await entriesModel().find().exec()).toMatchObject([
      { day: 'MON', section: 'LUNCH', recipeId: riceRecipeId, position: 0 },
    ]);
    expect(await entriesModel().countDocuments()).toBe(1);
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
      saveHttp([dayInput(Weekday.MON, first)]),
      saveHttp([dayInput(Weekday.MON, second)]),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(lunchIds(responses[0].body as MealPlanDto, Weekday.MON)).toEqual(
      first,
    );
    expect(lunchIds(responses[1].body as MealPlanDto, Weekday.MON)).toEqual(
      second,
    );
    const rows = await entriesModel().find().sort({ position: 1 }).exec();
    expect([first, second]).toContainEqual(
      rows.map(({ recipeId }) => recipeId),
    );
    expect(rows.map(({ position }) => position)).toEqual(
      rows.map((_, index) => index),
    );
  });

  it('keeps both changes when parallel PUTs replace different days', async () => {
    const responses = await Promise.all([
      saveHttp([dayInput(Weekday.MON, [riceRecipeId])]),
      saveHttp([dayInput(Weekday.TUE, [tofuRecipeId])]),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    const saved = await plan.find(userId);
    expect(lunchIds(saved, Weekday.MON)).toEqual([riceRecipeId]);
    expect(lunchIds(saved, Weekday.TUE)).toEqual([tofuRecipeId]);
    expect(await entriesModel().countDocuments()).toBe(2);
  });

  it('rolls back every requested day when one is invalid while another PUT succeeds', async () => {
    await plan.apply(userId, [dayInput(Weekday.MON, [riceRecipeId])]);
    await usersModel().updateOne(
      { _id: userId },
      { $set: { avoidedIngredientIds: [tofuId] } },
    );
    const responses = await Promise.all([
      saveHttp([
        dayInput(Weekday.MON, []),
        dayInput(Weekday.TUE, [tofuRecipeId]),
      ]),
      saveHttp([dayInput(Weekday.WED, [spinachRecipeId])]),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([409, 200]);
    expect(responses[0].body).toMatchObject({
      code: 'MEAL_PLAN_INVALID',
      problems: [{ recipeIds: [tofuRecipeId], recipes: ['Đậu hũ sốt cà'] }],
    });
    const saved = await plan.find(userId);
    expect(lunchIds(saved, Weekday.MON)).toEqual([riceRecipeId]);
    expect(lunchIds(saved, Weekday.TUE)).toEqual([]);
    expect(lunchIds(saved, Weekday.WED)).toEqual([spinachRecipeId]);
  });

  it('preserves removal-only repairs but checks existing dishes when a new one is added', async () => {
    await plan.apply(userId, [
      dayInput(Weekday.MON, [tofuRecipeId, riceRecipeId]),
    ]);
    await usersModel().updateOne(
      { _id: userId },
      { $set: { avoidedIngredientIds: [tofuId] } },
    );
    const rejected = await saveHttp([
      dayInput(Weekday.MON, [tofuRecipeId, riceRecipeId, spinachRecipeId]),
    ]);
    expect(rejected.status).toBe(409);
    expect((rejected.body as { problems: unknown }).problems).toMatchObject([
      { recipeIds: [tofuRecipeId] },
    ]);
    const repaired = await saveHttp([dayInput(Weekday.MON, [riceRecipeId])]);
    expect(repaired.status).toBe(200);
    expect(lunchIds(repaired.body as MealPlanDto, Weekday.MON)).toEqual([
      riceRecipeId,
    ]);
  });
});
