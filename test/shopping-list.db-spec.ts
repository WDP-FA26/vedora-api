import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  type MealPlanEntry,
  MealSection,
  type Recipe,
  type RecipeIngredient,
  type Stored,
  UserRole,
  Weekday,
} from '../src/mongo/models';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app.setup';
import { MongoModule } from '../src/mongo/mongo.module';
import { MongoService } from '../src/mongo/mongo.service';
import { ShoppingListController } from '../src/meal-plan/shopping-list.controller';
import { ShoppingListService } from '../src/meal-plan/shopping-list.service';
import type { ShoppingListDto } from '../src/meal-plan/dto/shopping-list.dto';
import { createIngredient, createRecipe, createUser } from './fixtures';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from './mongo-test-db';

describe('Shopping list with MongoDB', () => {
  let db: MongoService;
  let app: INestApplication<App>;
  let first: string;
  let second: string;
  let firstToken: string;
  let secondToken: string;
  let ingredientId: string;
  let otherIngredientId: string;
  let recipes: string[];
  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        MongoModule.forTest(createTestMongoUrl('shopping')),
        JwtModule.register({ secret: 'shopping-integration-test-secret' }),
      ],
      controllers: [ShoppingListController],
      providers: [
        ShoppingListService,
        {
          provide: ConfigService,
          useValue: new ConfigService({ API_PREFIX: 'api/v1' }),
        },
      ],
    }).compile();
    app = mod.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    const users = await Promise.all(
      ['first', 'second'].map((name) =>
        createUser(db, {
          username: `shopping.${name}`,
          fullName: name,
          email: `${name}@shopping.test`,
          role: name === 'second' ? UserRole.ADMIN : UserRole.USER,
        }),
      ),
    );
    [first, second] = users.map((u) => u.id);
    [firstToken, secondToken] = await Promise.all(
      users.map((u) =>
        app.get(JwtService).signAsync({ sub: u.id, username: u.username }),
      ),
    );
    ingredientId = (await createIngredient(db, { name: 'Đậu hũ' })).id;
    otherIngredientId = (await createIngredient(db, { name: 'Cà rốt' })).id;
    recipes = [];
    const sources = [
      { quantity: '0.10', unit: 'g', servings: 2, note: 'sliced' },
      { quantity: '0.20', unit: 'g', servings: 4, note: 'diced' },
      { quantity: null, unit: 'g', servings: 1, note: 'to taste' },
      { quantity: '1.00', unit: 'kg', servings: 3, note: null },
      {
        quantity: null,
        unit: null,
        servings: 1,
        note: 'unknown amount and unit',
      },
      { quantity: '5.00', unit: 'cái', servings: 2, note: null },
    ];
    for (const [index, source] of sources.entries()) {
      const recipe = await createRecipe(db, {
        title: `Shopping dish ${index}`,
        servings: source.servings,
      });
      await db.connection.model<RecipeIngredient>('RecipeIngredient').create({
        _id: randomUUID(),
        recipeId: recipe.id,
        ingredientId: index === 5 ? otherIngredientId : ingredientId,
        position: 0,
        quantity: source.quantity === null ? null : Number(source.quantity),
        unit: source.unit,
        note: source.note,
      });
      recipes.push(recipe.id);
    }
  });
  beforeEach(async () => {
    await db.db.collection('meal_plan_entries').deleteMany({});
    await db.connection
      .model<Recipe>('Recipe')
      .updateOne({ _id: recipes[0] }, { $set: { servings: 2 } });
    await db.connection
      .model<RecipeIngredient>('RecipeIngredient')
      .updateOne(
        { recipeId: recipes[0], ingredientId },
        { $set: { quantity: 0.1 } },
      );
    const slots = [
      {
        day: Weekday.MON,
        section: MealSection.BREAKFAST,
        recipeId: recipes[0],
      },
      { day: Weekday.MON, section: MealSection.LUNCH, recipeId: recipes[0] },
      { day: Weekday.MON, section: MealSection.DINNER, recipeId: recipes[1] },
      { day: Weekday.MON, section: MealSection.OTHER, recipeId: recipes[2] },
      { day: Weekday.TUE, section: MealSection.LUNCH, recipeId: recipes[3] },
      { day: Weekday.WED, section: MealSection.OTHER, recipeId: recipes[4] },
      { day: Weekday.THU, section: MealSection.DINNER, recipeId: recipes[5] },
    ] as const;
    await db.connection.model<MealPlanEntry>('MealPlanEntry').insertMany(
      slots.map((slot) => ({
        _id: randomUUID(),
        ...slot,
        userId: first,
        position: 0,
      })),
    );
    await plan({
      userId: second,
      day: Weekday.MON,
      section: MealSection.LUNCH,
      recipeId: recipes[1],
    });
  });
  afterAll(async () => {
    if (app) await dropTestDatabase(app);
    if (app) await app.close();
  });
  const entriesModel = () =>
    db.connection.model<MealPlanEntry>('MealPlanEntry');
  const plan = (entry: Omit<MealPlanEntry, 'id' | '_id' | 'position'>) =>
    entriesModel().create({
      _id: randomUUID(),
      position: 0,
      ...entry,
    });
  const get = (query = '', token = firstToken) =>
    request(app.getHttpServer())
      .get(`/api/v1/meal-plan/shopping-list${query}`)
      .set('Authorization', `Bearer ${token}`);

  it('sums Decimal quantities per occurrence, retaining unknown contributions and all four meal sections', async () => {
    const response = await get().expect(200);
    const data = response.body as ShoppingListDto;
    expect(data.items).toHaveLength(4);
    const grams = data.items.find(
      (item) => item.ingredientId === ingredientId && item.unit === 'g',
    )!;
    expect(grams).toMatchObject({
      knownQuantity: '0.40',
      hasUnknownQuantity: true,
    });
    expect(grams.contributions).toHaveLength(4);
    expect(grams.contributions.map((c) => c.section)).toEqual([
      'BREAKFAST',
      'LUNCH',
      'DINNER',
      'OTHER',
    ]);
    expect(grams.contributions.map((c) => c.quantity)).toEqual([
      '0.10',
      '0.10',
      '0.20',
      null,
    ]);
    expect(grams.contributions.map((c) => c.servings)).toEqual([2, 2, 4, 1]);
    expect(grams.contributions[3].note).toBe('to taste');
    expect(data.quantityBasis).toBe('RECIPE_PER_OCCURRENCE');
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
  it('counts a repeated recipe independently on another weekday', async () => {
    await plan({
      userId: first,
      day: Weekday.FRI,
      section: MealSection.OTHER,
      recipeId: recipes[0],
    });
    const data = (await get().expect(200)).body as ShoppingListDto;
    const grams = data.items.find(
      (item) => item.ingredientId === ingredientId && item.unit === 'g',
    )!;
    expect(grams.knownQuantity).toBe('0.50');
    expect(grams.contributions).toHaveLength(5);
    const friday = (await get('?days=FRI').expect(200)).body as ShoppingListDto;
    expect(friday.items[0].knownQuantity).toBe('0.10');
    expect(friday.items[0].contributions[0]).toMatchObject({
      day: Weekday.FRI,
      section: MealSection.OTHER,
      servings: 2,
    });
  });

  it('never merges different units or turns unknown-only amounts into zero', async () => {
    const data = (await get().expect(200)).body as ShoppingListDto;
    expect(data.items.find((i) => i.unit === 'kg')).toMatchObject({
      knownQuantity: '1.00',
      hasUnknownQuantity: false,
    });
    expect(data.items.find((i) => i.unit === null)).toMatchObject({
      knownQuantity: null,
      hasUnknownQuantity: true,
    });
    expect(
      data.items.find((i) => i.ingredientId === otherIngredientId),
    ).toMatchObject({
      unit: 'cái',
      knownQuantity: '5.00',
      hasUnknownQuantity: false,
    });
  });
  it('filters selected days before aggregation and returns weekdays in calendar order', async () => {
    const mon = (await get('?days=MON').expect(200)).body as ShoppingListDto;
    expect(mon.items).toHaveLength(1);
    expect(mon.items[0].knownQuantity).toBe('0.40');
    const selected = (await get('?days=THU,TUE').expect(200))
      .body as ShoppingListDto;
    expect(selected.days).toEqual(['TUE', 'THU']);
    expect(selected.items).toHaveLength(2);
    expect(
      selected.items
        .flatMap((i) => i.contributions)
        .map((c) => c.day)
        .sort(),
    ).toEqual(['THU', 'TUE']);
    expect((await get('?days=SUN').expect(200)).body).toMatchObject({
      days: ['SUN'],
      items: [],
    });
  });
  it('keeps the ADMIN caller on its own plan and rejects an injected owner', async () => {
    const data = (await get('', secondToken).expect(200))
      .body as ShoppingListDto;
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({
      knownQuantity: '0.20',
      hasUnknownQuantity: false,
    });
    expect(data.items[0].contributions).toHaveLength(1);
    await get(`?userId=${first}`, secondToken).expect(400);
  });
  it('returns an empty list for an empty own plan and does not change any stored plan', async () => {
    const stored = () =>
      entriesModel().find().sort({ userId: 1, _id: 1 }).exec();
    const before = await stored();
    await get().expect(200);
    expect(await stored()).toEqual(before);
    await entriesModel().deleteMany({ userId: first });
    expect((await get().expect(200)).body).toMatchObject({ items: [] });
  });
  // Writers in driver transactions, as the services write related documents.
  const entries = () =>
    db.db.collection<Stored<MealPlanEntry>>('meal_plan_entries');
  const items = () =>
    db.db.collection<Stored<RecipeIngredient>>('recipe_ingredients');

  it('does not mix a prior timetable with newer ingredient data', async () => {
    await entriesModel().deleteMany({ userId: first, day: Weekday.MON });
    await plan({
      userId: first,
      day: Weekday.MON,
      section: MealSection.LUNCH,
      recipeId: recipes[0],
    });
    const writer = (async () => {
      for (let index = 0; index < 10; index++) {
        const switched = index % 2 === 0;
        await db.withTransaction(async (session) => {
          await entries().deleteMany(
            { userId: first, day: Weekday.MON },
            { session },
          );
          await items().updateOne(
            { recipeId: recipes[0], ingredientId },
            { $set: { quantity: switched ? 0.9 : 0.1 } },
            { session },
          );
          await items().updateOne(
            { recipeId: recipes[1], ingredientId },
            { $set: { quantity: switched ? 0.8 : 0.2 } },
            { session },
          );
          await entries().insertOne(
            {
              _id: randomUUID(),
              userId: first,
              day: Weekday.MON,
              section: MealSection.LUNCH,
              recipeId: recipes[switched ? 1 : 0],
              position: 0,
            },
            { session },
          );
        });
      }
    })();
    const reads = await Promise.all(
      Array.from({ length: 20 }, () => get('?days=MON')),
    );
    await writer;
    for (const response of reads) {
      expect(response.status).toBe(200);
      const data = response.body as ShoppingListDto;
      expect(data.items).toHaveLength(1);
      expect(data.items[0].contributions).toHaveLength(1);
      const source = data.items[0].contributions[0];
      expect(source.quantity).toBe(
        source.recipeId === recipes[0] ? '0.10' : '0.80',
      );
      expect(data.items[0].knownQuantity).toBe(source.quantity);
    }
  });

  it('reads a consistent recipe/ingredient snapshot while both change atomically', async () => {
    const writer = (async () => {
      for (let index = 0; index < 10; index++) {
        const servings = index % 2 === 0 ? 4 : 2;
        await db.withTransaction(async (session) => {
          await db.db
            .collection<Stored<Recipe>>('recipes')
            .updateOne(
              { _id: recipes[0] },
              { $set: { servings } },
              { session },
            );
          await items().updateOne(
            { recipeId: recipes[0], ingredientId },
            { $set: { quantity: servings === 4 ? 0.2 : 0.1 } },
            { session },
          );
        });
      }
    })();
    const reads = await Promise.all(
      Array.from({ length: 20 }, () => get('?days=MON')),
    );
    await writer;
    expect(reads.map((r) => r.status)).toEqual(Array(20).fill(200));
    for (const response of reads) {
      const data = response.body as ShoppingListDto;
      const sources = data.items
        .flatMap((i) => i.contributions)
        .filter((c) => c.recipeId === recipes[0]);
      expect(sources).toHaveLength(2);
      for (const source of sources)
        expect(source.quantity).toBe(source.servings === 2 ? '0.10' : '0.20');
      expect(sources[0].quantity).toBe(sources[1].quantity);
    }
  });
});
