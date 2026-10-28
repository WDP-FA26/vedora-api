import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db';
import { MongoModule } from '../mongo/mongo.module';
import type { Recipe, RecipeIngredient } from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';
import { type SeedData, seedCatalog } from './seed-catalog';

const imageUrl = 'https://upload.wikimedia.org/dish.jpg';
const data: SeedData = {
  ingredients: [
    { name: 'Đậu hũ', aliases: [] },
    { name: 'Mật ong', aliases: [] },
  ],
  groups: [
    { name: 'Đậu', description: '', dietary: true, ingredients: ['Đậu hũ'] },
  ],
  rules: [
    {
      a: { kind: 'INGREDIENT', name: 'Đậu hũ' },
      b: { kind: 'INGREDIENT', name: 'Mật ong' },
      reason: 'Dễ đầy bụng',
      source: 'test',
    },
  ],
  recipes: [
    {
      title: 'Đậu hũ sốt cà',
      description: 'Món mặn',
      imageUrl,
      servings: 2,
      prepMinutes: 10,
      cookMinutes: 15,
      ingredients: [
        { name: 'Đậu hũ', quantity: 200, unit: 'g' },
        { name: 'Mật ong' },
      ],
      steps: ['Chiên đậu'],
    },
  ],
};

describe('Catalog seed', () => {
  let app: INestApplication;
  let mongo: MongoService;

  const recipe = () =>
    mongo.connection
      .model<Recipe>('Recipe')
      .findOne({ title: 'Đậu hũ sốt cà' })
      .exec();
  const count = (name: string) => mongo.connection.model(name).countDocuments();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('seedcatalog'))],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
  });
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (const collection of [
      'recipes',
      'recipe_ingredients',
      'ingredients',
      'ingredient_groups',
      'ingredient_group_members',
      'incompatibility_rules',
    ]) {
      await mongo.db.collection(collection).deleteMany({});
    }
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('creates a missing recipe with its photo and ingredients', async () => {
    await seedCatalog(mongo, data);

    expect(await recipe()).toMatchObject({ title: 'Đậu hũ sốt cà', imageUrl });
    const items = await mongo.connection
      .model<RecipeIngredient>('RecipeIngredient')
      .find()
      .sort({ position: 1 })
      .exec();
    expect(items).toMatchObject([
      { position: 0, quantity: 200, unit: 'g' },
      { position: 1, quantity: null, unit: null },
    ]);
    expect(await count('IngredientGroupMember')).toBe(1);
    expect(await count('IncompatibilityRule')).toBe(1);
  });

  it('adds nothing the second time', async () => {
    await seedCatalog(mongo, data);
    await seedCatalog(mongo, data);

    expect(await count('Recipe')).toBe(1);
    expect(await count('Ingredient')).toBe(2);
    expect(await count('RecipeIngredient')).toBe(2);
    expect(await count('IngredientGroupMember')).toBe(1);
    expect(await count('IncompatibilityRule')).toBe(1);
  });

  it('only fills in the photo of a recipe that already exists', async () => {
    await seedCatalog(mongo, data);
    await mongo.connection
      .model<Recipe>('Recipe')
      .updateOne({ title: 'Đậu hũ sốt cà' }, { $set: { imageUrl: null } });

    await seedCatalog(mongo, data);

    expect((await recipe())?.imageUrl).toBe(imageUrl);
    expect(await count('Recipe')).toBe(1);
  });

  it('keeps a photo an admin already chose', async () => {
    await seedCatalog(mongo, data);
    const chosen = 'https://images.pexels.com/other.jpg';
    await mongo.connection
      .model<Recipe>('Recipe')
      .updateOne({ title: 'Đậu hũ sốt cà' }, { $set: { imageUrl: chosen } });

    await seedCatalog(mongo, data);

    expect((await recipe())?.imageUrl).toBe(chosen);
  });
});
