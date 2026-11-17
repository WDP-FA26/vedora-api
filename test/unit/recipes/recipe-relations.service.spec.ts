import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InvalidInputException } from '../../../src/common/exceptions/invalid-input.exception.js';
import { type IncompatibilityRule, PostStatus } from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import { IncompatibilityRulesService } from '../../../src/recipes/incompatibility-rules.service.js';
import {
  RecipeRelationsService,
  sourcePostIds,
} from '../../../src/recipes/recipe-relations.service.js';
import {
  createIngredient,
  createPost,
  createRecipe,
  createUser,
} from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const TOFU_ID = 'a1a2d3e4-0000-4000-8000-000000000001';
const SPINACH_ID = 'a1a2d3e4-0000-4000-8000-000000000002';
const POST_PUB = 'e1a2d3e4-0000-4000-8000-000000000001';
const POST_PROC = 'e1a2d3e4-0000-4000-8000-000000000002';

describe('RecipeRelationsService', () => {
  let app: INestApplication;
  let mongo: MongoService;
  let service: RecipeRelationsService;

  const rules = () =>
    mongo.connection.model<IncompatibilityRule>('IncompatibilityRule');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('relations'))],
      providers: [RecipeRelationsService, IncompatibilityRulesService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    service = app.get(RecipeRelationsService);
  });

  beforeEach(async () => {
    for (const collection of [
      'recipes',
      'ingredients',
      'ingredient_groups',
      'incompatibility_rules',
      'posts',
      'users',
    ]) {
      await mongo.connection.collections[collection].deleteMany({});
    }
    await createUser(mongo, {
      id: USER_ID,
      username: 'author.one',
      fullName: 'Tác Giả',
    });
    await createIngredient(mongo, { id: TOFU_ID, name: 'Đậu hũ' });
    await createIngredient(mongo, { id: SPINACH_ID, name: 'Rau bina' });
    await createPost(mongo, {
      id: POST_PUB,
      authorId: USER_ID,
      status: PostStatus.PUBLISHED,
    });
    await createPost(mongo, {
      id: POST_PROC,
      authorId: USER_ID,
      status: PostStatus.PROCESSING,
    });
    await rules().create({
      _id: 'c1a2d3e4-0000-4000-8000-000000000001',
      aIngredientId: TOFU_ID,
      bIngredientId: SPINACH_ID,
      reason: 'Oxalat',
    });
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('hydrates recipes with ingredients, posts, authors, conflicts, and handles missing references', async () => {
    const withPostAndConflict = await createRecipe(
      mongo,
      {
        title: 'Món đầy đủ',
        postId: POST_PUB,
        steps: ['Bước 1', 'Bước 2'],
      },
      [TOFU_ID, SPINACH_ID],
    );
    const withMissingRefs = await createRecipe(
      mongo,
      {
        title: 'Món thiếu tham chiếu',
        postId: 'e1a2d3e4-0000-4000-8000-000000000099',
        ingredients: [
          {
            ingredientId: 'a1a2d3e4-0000-4000-8000-000000000099',
            quantity: 10,
            unit: 'g',
            note: null,
          },
        ],
      },
    );

    const hydrated = await service.hydrate([
      withPostAndConflict,
      withMissingRefs,
    ]);

    expect(hydrated[0]).toMatchObject({
      id: withPostAndConflict.id,
      ingredientCount: 2,
      conflictCount: 1,
      post: {
        id: POST_PUB,
        author: { username: 'author.one', fullName: 'Tác Giả' },
      },
      steps: ['Bước 1', 'Bước 2'],
    });
    expect(hydrated[0].conflicts[0]).toMatchObject({
      a: { id: TOFU_ID, name: 'Đậu hũ' },
      b: { id: SPINACH_ID, name: 'Rau bina' },
      reason: 'Oxalat',
    });

    expect(hydrated[1]).toMatchObject({
      post: null,
      ingredients: [{ name: '' }],
    });
  });

  it('finds published post ids and extracts non-null sourcePostIds', async () => {
    const ids = sourcePostIds([
      { postId: POST_PUB },
      { postId: null },
      { postId: undefined },
      { postId: POST_PROC },
    ]);
    expect(ids).toEqual([POST_PUB, POST_PROC]);

    const published = await service.publishedPostIds(ids);
    expect([...published]).toEqual([POST_PUB]);
  });

  it('validates ingredient and post references in assertReferences', async () => {
    await expect(
      service.assertReferences([{ ingredientId: TOFU_ID }]),
    ).resolves.toBeUndefined();

    await expect(
      service.assertReferences([{ ingredientId: TOFU_ID }], POST_PUB),
    ).resolves.toBeUndefined();

    await expect(
      service.assertReferences([
        { ingredientId: 'a1a2d3e4-0000-4000-8000-000000000099' },
      ]),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof InvalidInputException &&
        err.code === 'UNKNOWN_REFERENCE',
    );

    await expect(
      service.assertReferences(
        [{ ingredientId: TOFU_ID }],
        'e1a2d3e4-0000-4000-8000-000000000099',
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof InvalidInputException &&
        err.code === 'UNKNOWN_REFERENCE',
    );
  });
});
