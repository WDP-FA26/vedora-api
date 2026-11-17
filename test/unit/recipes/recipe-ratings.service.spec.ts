import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccessDeniedException } from '../../../src/common/exceptions/access-denied.exception.js';
import { ResourceNotFoundException } from '../../../src/common/exceptions/resource-not-found.exception.js';
import { UnauthenticatedException } from '../../../src/common/exceptions/unauthenticated.exception.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import { RecipeRatingsService } from '../../../src/recipes/recipe-ratings.service.js';
import {
  createRecipe,
  createUser,
} from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

const AUTHOR_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff1';
const USER_1 = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const USER_2 = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff3';
const UNVERIFIED_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff4';
const RECIPE_ID = 'd1a2d3e4-0000-4000-8000-000000000001';

describe('RecipeRatingsService', () => {
  let app: INestApplication;
  let mongo: MongoService;
  let service: RecipeRatingsService;

  const users = () => mongo.connection.model('User');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('ratings'))],
      providers: [RecipeRatingsService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    service = app.get(RecipeRatingsService);
  });

  beforeEach(async () => {
    for (const collection of ['recipe_ratings', 'recipes', 'users']) {
      await mongo.connection.collections[collection].deleteMany({});
    }
    await createUser(mongo, { id: AUTHOR_ID, username: 'author' });
    await createUser(mongo, { id: USER_1, username: 'rater1' });
    await createUser(mongo, { id: USER_2, username: 'rater2' });
    await createUser(mongo, {
      id: UNVERIFIED_ID,
      username: 'unverified',
      emailVerifiedAt: null,
    });
    await createRecipe(mongo, {
      id: RECIPE_ID,
      title: 'Đậu hũ sốt cà',
      createdById: AUTHOR_ID,
    });
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('returns zero count and null average when unrated, and rounds mean to 1 decimal', async () => {
    await expect(service.summary(RECIPE_ID)).resolves.toEqual({
      recipeId: RECIPE_ID,
      ratingCount: 0,
      averageRating: null,
    });
    await expect(service.mine(RECIPE_ID, USER_1)).resolves.toEqual({
      recipeId: RECIPE_ID,
      ratingCount: 0,
      averageRating: null,
      myRating: null,
    });

    await service.set(RECIPE_ID, USER_1, 4);
    // Updating own rating does not duplicate count
    await service.set(RECIPE_ID, USER_1, 5);
    await service.set(RECIPE_ID, USER_2, 4);

    await expect(service.summary(RECIPE_ID)).resolves.toEqual({
      recipeId: RECIPE_ID,
      ratingCount: 2,
      averageRating: 4.5,
    });
    await expect(service.mine(RECIPE_ID, USER_1)).resolves.toEqual({
      recipeId: RECIPE_ID,
      ratingCount: 2,
      averageRating: 4.5,
      myRating: 5,
    });
  });

  it('excludes unverified users from aggregate and prevents unverified users from setting a score while allowing removal', async () => {
    await expect(
      service.set(RECIPE_ID, UNVERIFIED_ID, 5),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AccessDeniedException &&
        err.code === 'EMAIL_NOT_VERIFIED',
    );

    // Verify, rate, then become unverified: aggregate excludes unverified rating, and user can still remove it
    await service.set(RECIPE_ID, USER_1, 5);
    await users().updateOne(
      { _id: USER_1 },
      { $set: { emailVerifiedAt: null } },
    );
    await expect(service.summary(RECIPE_ID)).resolves.toEqual({
      recipeId: RECIPE_ID,
      ratingCount: 0,
      averageRating: null,
    });
    await expect(service.set(RECIPE_ID, USER_1, null)).resolves.toEqual({
      recipeId: RECIPE_ID,
      ratingCount: 0,
      averageRating: null,
      myRating: null,
    });
  });

  it('blocks self-rating by the recipe author', async () => {
    await expect(service.set(RECIPE_ID, AUTHOR_ID, 5)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AccessDeniedException &&
        err.code === 'SELF_RATING_NOT_ALLOWED',
    );
  });

  it('throws 401 for missing user and 404 for missing recipe', async () => {
    await expect(
      service.set(RECIPE_ID, '4a1e32e4-e18e-4dd7-8b4a-246ef2113fff', 4),
    ).rejects.toBeInstanceOf(UnauthenticatedException);

    const missingRecipe = 'd1a2d3e4-0000-4000-8000-000000000099';
    await expect(service.summary(missingRecipe)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
    await expect(service.mine(missingRecipe, USER_1)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
    await expect(service.set(missingRecipe, USER_1, 4)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });
});
