import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InvalidInputException } from '@src/common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '@src/common/exceptions/resource-not-found.exception.js';
import { PostStatus, type RecipeFavorite } from '@src/mongo/models.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import { IncompatibilityRulesService } from '@src/recipes/incompatibility-rules.service.js';
import { RecipeRelationsService } from '@src/recipes/recipe-relations.service.js';
import { RecipesService } from '@src/recipes/recipes.service.js';
import {
  createIngredient,
  createPost,
  createUser,
} from '@test/support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';

const ADMIN_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const TOFU_ID = 'a1a2d3e4-0000-4000-8000-000000000001';
const TOMATO_ID = 'a1a2d3e4-0000-4000-8000-000000000002';
const POST_ID = 'e1a2d3e4-0000-4000-8000-000000000001';

describe('RecipesService', () => {
  let app: INestApplication;
  let mongo: MongoService;
  let service: RecipesService;

  const favorites = () =>
    mongo.connection.model<RecipeFavorite>('RecipeFavorite');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('recipes_svc'))],
      providers: [
        RecipesService,
        RecipeRelationsService,
        IncompatibilityRulesService,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    service = app.get(RecipesService);
  });

  beforeEach(async () => {
    for (const collection of [
      'recipes',
      'recipe_favorites',
      'recipe_ratings',
      'meal_plan_week_entries',
      'ingredients',
      'ingredient_groups',
      'incompatibility_rules',
      'posts',
      'users',
    ]) {
      await mongo.connection.collections[collection].deleteMany({});
    }
    await createUser(mongo, { id: ADMIN_ID, username: 'vedora.admin' });
    await createIngredient(mongo, { id: TOFU_ID, name: 'Đậu hũ' });
    await createIngredient(mongo, { id: TOMATO_ID, name: 'Cà chua' });
    await createPost(mongo, {
      id: POST_ID,
      authorId: ADMIN_ID,
      status: PostStatus.PUBLISHED,
    });
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('creates, fetches, lists as cards, updates, and deletes recipes with cascade', async () => {
    const created = await service.create(ADMIN_ID, {
      title: 'Đậu hũ sốt cà',
      description: 'Món chay gia đình',
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/dish.jpg',
      servings: 2,
      prepMinutes: 10,
      cookMinutes: 15,
      ingredients: [
        { ingredientId: TOFU_ID, quantity: 200, unit: 'g', note: 'cắt miếng' },
        { ingredientId: TOMATO_ID },
      ],
      steps: ['Rán đậu', 'Sốt cà chua'],
      postId: POST_ID,
    });

    expect(created).toMatchObject({
      title: 'Đậu hũ sốt cà',
      description: 'Món chay gia đình',
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/dish.jpg',
      servings: 2,
      prepMinutes: 10,
      cookMinutes: 15,
      ingredientCount: 2,
      post: { id: POST_ID, author: { username: 'vedora.admin' } },
    });
    expect(created.ingredients[1]).toMatchObject({
      ingredientId: TOMATO_ID,
      quantity: null,
      unit: null,
      note: null,
    });

    const second = await service.create(ADMIN_ID, {
      title: 'Đậu hũ luộc',
      servings: 1,
      ingredients: [{ ingredientId: TOFU_ID }],
      steps: ['Luộc'],
    });
    expect(second.description).toBeNull();
    expect(second.imageUrl).toBeNull();
    expect(second.prepMinutes).toBeNull();
    expect(second.cookMinutes).toBeNull();
    expect(second.post).toBeNull();

    const list = await service.findAll({ page: 1, limit: 10 });
    expect(list.meta.totalItems).toBe(2);
    expect(list.items[0].id).toBe(second.id);
    expect(list.items[0]).not.toHaveProperty('steps');

    const updated = await service.update(created.id, {
      title: 'Đậu hũ sốt cà mới',
      servings: 4,
      ingredients: [{ ingredientId: TOMATO_ID, quantity: 3, unit: 'quả' }],
      steps: ['Nấu nhanh'],
    });
    expect(updated).toMatchObject({
      title: 'Đậu hũ sốt cà mới',
      description: null,
      imageUrl: null,
      prepMinutes: null,
      cookMinutes: null,
      post: null,
      ingredientCount: 1,
    });

    await favorites().create({
      recipeId: created.id,
      userId: ADMIN_ID,
      createdAt: new Date(),
    });
    await service.remove(created.id);
    expect(await favorites().countDocuments({ recipeId: created.id })).toBe(0);

    await expect(service.findOne(created.id)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
    await expect(service.remove(created.id)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it('rejects unknown ingredient/post references and missing recipe on update', async () => {
    await expect(
      service.create(ADMIN_ID, {
        title: 'Sai nguyên liệu',
        servings: 1,
        ingredients: [{ ingredientId: 'a1a2d3e4-0000-4000-8000-000000000099' }],
        steps: ['Nấu'],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof InvalidInputException &&
        err.code === 'UNKNOWN_REFERENCE',
    );

    await expect(
      service.update('d1a2d3e4-0000-4000-8000-000000000099', {
        title: 'Không tồn tại',
        servings: 1,
        ingredients: [{ ingredientId: TOFU_ID }],
        steps: ['Nấu'],
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });
});
