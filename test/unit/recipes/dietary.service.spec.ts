import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InvalidInputException } from '../../../src/common/exceptions/invalid-input.exception.js';
import type { IngredientGroup } from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import { DietaryService } from '../../../src/recipes/dietary.service.js';
import { createIngredient, createUser } from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const TOFU_ID = 'a1a2d3e4-0000-4000-8000-000000000001';
const GARLIC_ID = 'a1a2d3e4-0000-4000-8000-000000000002';
const ONION_ID = 'a1a2d3e4-0000-4000-8000-000000000003';
const ALLIUM_GROUP = 'b1a2d3e4-0000-4000-8000-000000000001';
const HIDDEN_GROUP = 'b1a2d3e4-0000-4000-8000-000000000002';

describe('DietaryService', () => {
  let app: INestApplication;
  let mongo: MongoService;
  let service: DietaryService;

  const groups = () =>
    mongo.connection.model<IngredientGroup>('IngredientGroup');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('dietary'))],
      providers: [DietaryService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    service = app.get(DietaryService);
  });

  beforeEach(async () => {
    for (const collection of ['ingredients', 'ingredient_groups', 'users']) {
      await mongo.connection.collections[collection].deleteMany({});
    }
    await createUser(mongo, { id: USER_ID, username: 'dietary.user' });
    await createIngredient(mongo, {
      id: TOFU_ID,
      name: 'Đậu hũ',
      aliases: ['Tofu'],
    });
    await createIngredient(mongo, { id: GARLIC_ID, name: 'Tỏi' });
    await createIngredient(mongo, { id: ONION_ID, name: 'Hành' });
    await groups().create({
      _id: ALLIUM_GROUP,
      name: 'Ngũ vị tân',
      dietary: true,
      ingredientIds: [GARLIC_ID, ONION_ID],
    });
    await groups().create({
      _id: HIDDEN_GROUP,
      name: 'Nhóm nội bộ',
      dietary: false,
      ingredientIds: [TOFU_ID],
    });
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('lists all ingredients and only dietary=true groups sorted by name', async () => {
    const opts = await service.options();

    expect(opts.ingredients.map((i) => i.name)).toEqual([
      'Hành',
      'Tỏi',
      'Đậu hũ',
    ]);
    expect(opts.ingredients.find((i) => i.id === TOFU_ID)?.aliases).toEqual([
      'Tofu',
    ]);
    expect(opts.groups).toEqual([
      {
        id: ALLIUM_GROUP,
        name: 'Ngũ vị tân',
        ingredients: ['Hành', 'Tỏi'],
      },
    ]);
  });

  it('returns empty preferences when user does not exist', async () => {
    await expect(
      service.find('4a1e32e4-e18e-4dd7-8b4a-246ef2113fff'),
    ).resolves.toEqual({
      ingredients: [],
      groups: [],
      liked: [],
      terms: [],
    });
  });

  it('replaces, reads back, and expands avoided ingredients from both direct and group selections', async () => {
    const saved = await service.replace(USER_ID, {
      ingredientIds: [ONION_ID],
      groupIds: [ALLIUM_GROUP],
      likedIngredientIds: [TOFU_ID],
    });

    expect(saved).toEqual({
      ingredients: [{ id: ONION_ID, name: 'Hành' }],
      groups: [{ id: ALLIUM_GROUP, name: 'Ngũ vị tân' }],
      liked: [{ id: TOFU_ID, name: 'Đậu hũ' }],
    });

    await expect(service.find(USER_ID)).resolves.toEqual(saved);

    const avoided = await service.avoidedIngredientIds(USER_ID);
    expect([...avoided].sort()).toEqual([GARLIC_ID, ONION_ID].sort());
  });

  it('rejects an ingredient that is both avoided and liked', async () => {
    await expect(
      service.replace(USER_ID, {
        ingredientIds: [TOFU_ID],
        groupIds: [],
        likedIngredientIds: [TOFU_ID],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof InvalidInputException &&
        err.code === 'CONFLICTING_PREFERENCE',
    );
  });

  it('rejects unknown ingredient or group references', async () => {
    await expect(
      service.replace(USER_ID, {
        ingredientIds: ['a1a2d3e4-0000-4000-8000-000000000099'],
        groupIds: [],
        likedIngredientIds: [],
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_REFERENCE' });

    await expect(
      service.replace(USER_ID, {
        ingredientIds: [],
        groupIds: ['b1a2d3e4-0000-4000-8000-000000000099'],
        likedIngredientIds: [],
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_REFERENCE' });
  });
});
