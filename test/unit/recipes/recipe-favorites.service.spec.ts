import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ResourceNotFoundException } from '@src/common/exceptions/resource-not-found.exception.js';
import { UnauthenticatedException } from '@src/common/exceptions/unauthenticated.exception.js';
import { PostStatus, type RecipeFavorite } from '@src/mongo/models.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import { IncompatibilityRulesService } from '@src/recipes/incompatibility-rules.service.js';
import { RecipeFavoritesService } from '@src/recipes/recipe-favorites.service.js';
import { RecipeRelationsService } from '@src/recipes/recipe-relations.service.js';
import {
  createIngredient,
  createPost,
  createRecipe,
  createUser,
} from '@test/support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const TOFU_ID = 'a1a2d3e4-0000-4000-8000-000000000001';
const RECIPE_1 = 'd1a2d3e4-0000-4000-8000-000000000001';
const RECIPE_2 = 'd1a2d3e4-0000-4000-8000-000000000002';
const PUB_POST = 'e1a2d3e4-0000-4000-8000-000000000001';
const DRAFT_POST = 'e1a2d3e4-0000-4000-8000-000000000002';

describe('RecipeFavoritesService', () => {
  let app: INestApplication;
  let mongo: MongoService;
  let service: RecipeFavoritesService;

  const favorites = () =>
    mongo.connection.model<RecipeFavorite>('RecipeFavorite');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('favorites'))],
      providers: [
        RecipeFavoritesService,
        RecipeRelationsService,
        IncompatibilityRulesService,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    service = app.get(RecipeFavoritesService);
  });

  beforeEach(async () => {
    for (const collection of [
      'recipe_favorites',
      'recipes',
      'ingredients',
      'ingredient_groups',
      'incompatibility_rules',
      'posts',
      'users',
    ]) {
      await mongo.connection.collections[collection].deleteMany({});
    }
    await createUser(mongo, { id: USER_ID, username: 'saver' });
    await createIngredient(mongo, { id: TOFU_ID, name: 'Đậu hũ' });
    await createPost(mongo, {
      id: PUB_POST,
      authorId: USER_ID,
      status: PostStatus.PUBLISHED,
    });
    await createPost(mongo, {
      id: DRAFT_POST,
      authorId: USER_ID,
      status: PostStatus.PROCESSING,
    });
    await createRecipe(
      mongo,
      { id: RECIPE_1, title: 'Món 1', postId: PUB_POST, prepMinutes: 10 },
      [TOFU_ID],
    );
    await createRecipe(
      mongo,
      { id: RECIPE_2, title: 'Món 2', postId: DRAFT_POST },
      [TOFU_ID],
    );
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('saves and removes favorites idempotently while preserving original savedAt on repeat save', async () => {
    await expect(service.set(RECIPE_1, USER_ID, true)).resolves.toEqual({
      recipeId: RECIPE_1,
      isFavorite: true,
    });
    const firstDoc = await favorites().findOne({
      recipeId: RECIPE_1,
      userId: USER_ID,
    });
    expect(firstDoc).not.toBeNull();

    await service.set(RECIPE_1, USER_ID, true);
    const secondDoc = await favorites().findOne({
      recipeId: RECIPE_1,
      userId: USER_ID,
    });
    expect(secondDoc?.createdAt.getTime()).toBe(firstDoc?.createdAt.getTime());

    await expect(service.set(RECIPE_1, USER_ID, false)).resolves.toEqual({
      recipeId: RECIPE_1,
      isFavorite: false,
    });
    await expect(service.set(RECIPE_1, USER_ID, false)).resolves.toEqual({
      recipeId: RECIPE_1,
      isFavorite: false,
    });
    expect(await favorites().countDocuments({ userId: USER_ID })).toBe(0);
  });

  it('rejects deleted users and nonexistent recipes', async () => {
    await expect(
      service.set(RECIPE_1, '4a1e32e4-e18e-4dd7-8b4a-246ef2113fff', true),
    ).rejects.toBeInstanceOf(UnauthenticatedException);

    await expect(
      service.set('d1a2d3e4-0000-4000-8000-000000000099', USER_ID, true),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('lists favorites newest saved first with published post gate and pagination', async () => {
    await favorites().create({
      recipeId: RECIPE_1,
      userId: USER_ID,
      createdAt: new Date('2026-10-01T10:00:00Z'),
    });
    await favorites().create({
      recipeId: RECIPE_2,
      userId: USER_ID,
      createdAt: new Date('2026-10-02T10:00:00Z'),
    });

    const page = await service.list(USER_ID, { page: 1, limit: 10 });
    expect(page.meta.totalItems).toBe(2);
    expect(page.items.map((item) => item.id)).toEqual([RECIPE_2, RECIPE_1]);
    expect(page.items[0]).toMatchObject({
      id: RECIPE_2,
      isFavorite: true,
      post: null,
      totalMinutes: null,
    });
    expect(page.items[1]).toMatchObject({
      id: RECIPE_1,
      isFavorite: true,
      totalMinutes: 10,
      post: { id: PUB_POST },
    });

    const emptyPage = await service.list(USER_ID, { page: 5, limit: 10 });
    expect(emptyPage.items).toEqual([]);
    expect(emptyPage.meta.totalItems).toBe(2);
  });
});
