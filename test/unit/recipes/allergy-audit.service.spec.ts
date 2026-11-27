import type { INestApplication } from '@nestjs/common';
import { FakeModel, providerError } from '@nestjs/ai/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { Model } from 'mongoose';
import {
  createIngredient,
  createRecipe,
  createUser,
} from '@test/support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { AllergyVerdict, Ingredient, Recipe } from '@src/mongo/models.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import {
  AllergyAuditService,
  allergyWarningOf,
  UNCHECKED_ALLERGY_WARNING,
} from '@src/recipes/allergy-audit.service.js';
import type { DietaryService } from '@src/recipes/dietary.service.js';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const PEANUT_REASON = 'Có đậu phộng rang';

describe('AllergyAuditService', () => {
  let app: INestApplication;
  let mongo: MongoService;
  let verdicts: Model<AllergyVerdict>;
  let recipes: Model<Recipe>;
  let dietary: DeepMockProxy<DietaryService>;
  let model: FakeModel;
  let failNext: boolean;
  let service: AllergyAuditService;
  let peanutDish: string;
  let plainDish: string;

  const answer = () =>
    new FakeModel((call) => {
      if (failNext) return providerError({ status: 503 });
      const prompt = (call.lastUserMessage ?? '').toLowerCase();
      const flagged =
        prompt.includes(peanutDish) && prompt.includes('đậu phộng')
          ? [{ recipeId: peanutDish, reason: PEANUT_REASON }]
          : [];
      return { object: { flagged, summary: 'ok' } };
    });

  const allergies = (lines: string[]) =>
    dietary.find.mockResolvedValue({ allergies: lines, preferences: [] });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('allergy_audit'))],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    verdicts = app.get(getModelToken(AllergyVerdict.name));
    recipes = app.get(getModelToken(Recipe.name));
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  beforeEach(async () => {
    for (const collection of [
      'recipes',
      'ingredients',
      'users',
      'allergy_verdicts',
    ]) {
      await mongo.connection.collections[collection].deleteMany({});
    }
    await createUser(mongo, { id: USER_ID, username: 'allergy.user' });
    const peanut = await createIngredient(mongo, { name: 'Đậu phộng' });
    const squash = await createIngredient(mongo, { name: 'Bí đao' });
    peanutDish = (
      await createRecipe(mongo, { title: 'Gỏi ngó sen' }, [peanut.id])
    ).id;
    plainDish = (await createRecipe(mongo, { title: 'Canh bí' }, [squash.id]))
      .id;
    failNext = false;
    model = answer();
    dietary = mockDeep<DietaryService>();
    allergies(['Dị ứng lạc']);
    service = new AllergyAuditService(
      model,
      verdicts,
      recipes,
      app.get<Model<Ingredient>>(getModelToken(Ingredient.name)),
      dietary,
    );
  });

  it('skips the model when the user has no allergy lines', async () => {
    allergies(['  ']);
    const check = await service.check(USER_ID, [peanutDish, plainDish]);
    expect(check.unsafe.size).toBe(0);
    expect(check.unchecked.size).toBe(0);
    expect(model.calls).toHaveLength(0);
  });

  it('flags what the model flags and reuses stored verdicts', async () => {
    const first = await service.check(USER_ID, [peanutDish, plainDish]);
    expect([...first.unsafe]).toEqual([[peanutDish, PEANUT_REASON]]);
    expect(allergyWarningOf(first, plainDish)).toBeNull();
    expect(model.calls).toHaveLength(1);
    expect(model.lastCall?.lastUserMessage).toContain('Dị ứng lạc');
    expect(await verdicts.countDocuments({ userId: USER_ID })).toBe(2);

    const again = await service.check(USER_ID, [plainDish, peanutDish]);
    expect(again.unsafe.get(peanutDish)).toBe(PEANUT_REASON);
    expect(model.calls).toHaveLength(1);
  });

  it('checks every dish again after the allergy profile changes', async () => {
    await service.check(USER_ID, [peanutDish, plainDish]);
    allergies(['Dị ứng lạc', 'Không ăn được bí']);
    await service.check(USER_ID, [peanutDish, plainDish]);
    expect(model.calls).toHaveLength(2);
    expect(model.lastCall?.lastUserMessage).toContain('Không ăn được bí');
  });

  it('checks a dish again after its recipe changes', async () => {
    await service.check(USER_ID, [peanutDish, plainDish]);
    await recipes.updateOne(
      { _id: plainDish },
      { $set: { steps: ['Nấu canh', 'Rắc đậu phộng'] } },
    );
    await service.check(USER_ID, [peanutDish, plainDish]);
    expect(model.calls).toHaveLength(2);
    expect(model.lastCall?.lastUserMessage).toContain('Rắc đậu phộng');
    expect(model.lastCall?.lastUserMessage).not.toContain('Gỏi ngó sen');
  });

  it('marks dishes unchecked and stores nothing when the model fails', async () => {
    failNext = true;
    const check = await service.check(USER_ID, [peanutDish, plainDish]);
    expect(check.unsafe.size).toBe(0);
    expect([...check.unchecked].sort()).toEqual([peanutDish, plainDish].sort());
    expect(allergyWarningOf(check, plainDish)).toBe(UNCHECKED_ALLERGY_WARNING);
    expect(await verdicts.countDocuments({ userId: USER_ID })).toBe(0);

    failNext = false;
    const retried = await service.check(USER_ID, [peanutDish, plainDish]);
    expect(retried.unchecked.size).toBe(0);
    expect(retried.unsafe.has(peanutDish)).toBe(true);
  });
});
