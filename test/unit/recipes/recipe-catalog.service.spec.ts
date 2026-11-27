import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ResourceNotFoundException } from '@src/common/exceptions/resource-not-found.exception.js';
import { UnauthenticatedException } from '@src/common/exceptions/unauthenticated.exception.js';
import {
  type IncompatibilityRule,
  type IngredientGroup,
  PostStatus,
  type RecipeFavorite,
} from '@src/mongo/models.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import { DietaryService } from '@src/recipes/dietary.service.js';
import { IncompatibilityRulesService } from '@src/recipes/incompatibility-rules.service.js';
import { RecipeCatalogService } from '@src/recipes/recipe-catalog.service.js';
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
import {
  type AllergyCheck,
  AllergyAuditService,
} from '@src/recipes/allergy-audit.service.js';

const flagged = new Map<string, string>();
const fakeAllergyAudit = {
  check: (
    _userId: string,
    recipeIds: readonly string[],
  ): Promise<AllergyCheck> => {
    const unsafe = new Map<string, string>();
    for (const id of recipeIds) {
      const reason = flagged.get(id);
      if (reason !== undefined) unsafe.set(id, reason);
    }
    return Promise.resolve({ unsafe, unchecked: new Set<string>() });
  },
};

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const TOFU_ID = 'a1a2d3e4-0000-4000-8000-000000000001';
const SPINACH_ID = 'a1a2d3e4-0000-4000-8000-000000000002';
const GARLIC_ID = 'a1a2d3e4-0000-4000-8000-000000000003';
const MUSHROOM_ID = 'a1a2d3e4-0000-4000-8000-000000000004';
const GROUP_ALLIUM = 'b1a2d3e4-0000-4000-8000-000000000001';
const PUB_POST = 'e1a2d3e4-0000-4000-8000-000000000001';
const DRAFT_POST = 'e1a2d3e4-0000-4000-8000-000000000002';

describe('RecipeCatalogService', () => {
  let app: INestApplication;
  let mongo: MongoService;
  let service: RecipeCatalogService;

  const groups = () =>
    mongo.connection.model<IngredientGroup>('IngredientGroup');
  const rules = () =>
    mongo.connection.model<IncompatibilityRule>('IncompatibilityRule');
  const favorites = () =>
    mongo.connection.model<RecipeFavorite>('RecipeFavorite');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('catalog'))],
      providers: [
        RecipeCatalogService,
        RecipeRelationsService,
        IncompatibilityRulesService,
        DietaryService,
        { provide: AllergyAuditService, useValue: fakeAllergyAudit },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    service = app.get(RecipeCatalogService);
  });

  beforeEach(async () => {
    for (const collection of [
      'recipes',
      'recipe_favorites',
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
      username: 'reader',
      allergies: ['Kiêng rau bina', 'Ăn chay ngũ vị tân'],
    });
    await createIngredient(mongo, {
      id: TOFU_ID,
      name: 'Đậu hũ',
      aliases: ['Tofu [50%]'],
    });
    await createIngredient(mongo, { id: SPINACH_ID, name: 'Rau bina' });
    await createIngredient(mongo, { id: GARLIC_ID, name: 'Tỏi' });
    await createIngredient(mongo, { id: MUSHROOM_ID, name: 'Nấm hương' });
    await groups().create({
      _id: GROUP_ALLIUM,
      name: 'Ngũ vị tân',
      dietary: true,
      ingredientIds: [GARLIC_ID],
    });
    await rules().create({
      _id: 'c1a2d3e4-0000-4000-8000-000000000001',
      aIngredientId: TOFU_ID,
      bIngredientId: MUSHROOM_ID,
      reason: 'Giả lập kỵ nhau',
    });
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
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('rejects suitableForMe=true for anonymous callers', async () => {
    await expect(
      service.list({ page: 1, limit: 20, suitableForMe: true }),
    ).rejects.toBeInstanceOf(UnauthenticatedException);
  });

  it('lists catalog for guests and authenticated users, hiding non-published posts and showing favorite state', async () => {
    const r1 = await createRecipe(
      mongo,
      {
        title: 'Đậu hũ hấp',
        prepMinutes: 10,
        cookMinutes: null,
        postId: PUB_POST,
      },
      [TOFU_ID],
    );
    const r2 = await createRecipe(
      mongo,
      {
        title: 'Nấm xào',
        prepMinutes: null,
        cookMinutes: null,
        postId: DRAFT_POST,
      },
      [MUSHROOM_ID],
    );
    await favorites().create({
      recipeId: r1.id,
      userId: USER_ID,
      createdAt: new Date(),
    });

    const guestPage = await service.list({
      page: 1,
      limit: 20,
      suitableForMe: false,
    });
    expect(guestPage.meta.totalItems).toBe(2);
    expect(guestPage.items.every((item) => item.isFavorite === false)).toBe(
      true,
    );
    const guestR1 = guestPage.items.find((i) => i.id === r1.id);
    const guestR2 = guestPage.items.find((i) => i.id === r2.id);
    expect(guestR1?.post?.id).toBe(PUB_POST);
    expect(guestR1?.totalMinutes).toBe(10);
    expect(guestR2?.post).toBeNull();
    expect(guestR2?.totalMinutes).toBeNull();

    const userPage = await service.list(
      { page: 1, limit: 20, suitableForMe: false },
      USER_ID,
    );
    expect(userPage.items.find((i) => i.id === r1.id)?.isFavorite).toBe(true);
    expect(userPage.items.find((i) => i.id === r2.id)?.isFavorite).toBe(false);
  });

  it('filters by search query (escaping regex metacharacters), maxMinutes, and suitableForMe before pagination', async () => {
    const safe = await createRecipe(
      mongo,
      {
        title: 'Đậu hũ chiên',
        description: 'Nhanh gọn',
        prepMinutes: 5,
        cookMinutes: 10,
      },
      [TOFU_ID],
    );
    const avoidedDirect = await createRecipe(
      mongo,
      { title: 'Canh rau bina', prepMinutes: 5, cookMinutes: 5 },
      [SPINACH_ID],
    );
    const avoidedGroup = await createRecipe(
      mongo,
      { title: 'Nấm xào tỏi', prepMinutes: 5, cookMinutes: 10 },
      [GARLIC_ID, MUSHROOM_ID],
    );
    flagged.set(avoidedDirect.id, 'Có rau bina');
    flagged.set(avoidedGroup.id, 'Tỏi thuộc ngũ vị tân');
    const internalConflict = await createRecipe(
      mongo,
      { title: 'Đậu hũ xào nấm', prepMinutes: 5, cookMinutes: 10 },
      [TOFU_ID, MUSHROOM_ID],
    );
    const noTime = await createRecipe(
      mongo,
      {
        title: 'Nấm kho',
        description: 'Đậm đà',
        prepMinutes: null,
        cookMinutes: null,
      },
      [MUSHROOM_ID],
    );

    const byAlias = await service.list({
      page: 1,
      limit: 20,
      q: '[50%]',
      suitableForMe: false,
    });
    expect(byAlias.items.map((i) => i.id)).toEqual(
      expect.arrayContaining([safe.id, internalConflict.id]),
    );
    expect(byAlias.items.map((i) => i.id)).not.toContain(noTime.id);

    const quick = await service.list({
      page: 1,
      limit: 20,
      maxMinutes: 15,
      suitableForMe: false,
    });
    expect(quick.items.map((i) => i.id)).not.toContain(noTime.id);
    expect(quick.items.map((i) => i.id)).toContain(safe.id);

    const suitable = await service.list(
      { page: 1, limit: 1, suitableForMe: true },
      USER_ID,
    );
    expect(suitable.meta.totalItems).toBe(2);
    expect(suitable.items).toHaveLength(1);
    const suitableAll = await service.list(
      { page: 1, limit: 20, suitableForMe: true },
      USER_ID,
    );
    const suitableIds = suitableAll.items.map((i) => i.id);
    expect(suitableIds).toEqual(expect.arrayContaining([safe.id, noTime.id]));
    expect(suitableIds).not.toContain(avoidedDirect.id);
    expect(suitableIds).not.toContain(avoidedGroup.id);
    expect(suitableIds).not.toContain(internalConflict.id);

    const emptyPage = await service.list({
      page: 99,
      limit: 20,
      suitableForMe: false,
    });
    expect(emptyPage.items).toEqual([]);
    expect(emptyPage.meta.totalItems).toBe(5);
  });

  it('returns recipe detail with favorite status and throws 404 when not found', async () => {
    const recipe = await createRecipe(
      mongo,
      {
        title: 'Canh nấm',
        prepMinutes: 5,
        cookMinutes: 10,
        postId: DRAFT_POST,
      },
      [MUSHROOM_ID],
    );
    await favorites().create({
      recipeId: recipe.id,
      userId: USER_ID,
      createdAt: new Date(),
    });

    const detail = await service.findOne(recipe.id, USER_ID);
    expect(detail).toMatchObject({
      id: recipe.id,
      isFavorite: true,
      totalMinutes: 15,
      post: null,
    });

    const guestDetail = await service.findOne(recipe.id);
    expect(guestDetail.isFavorite).toBe(false);

    await expect(
      service.findOne('d1a2d3e4-0000-4000-8000-000000000099'),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });
});
