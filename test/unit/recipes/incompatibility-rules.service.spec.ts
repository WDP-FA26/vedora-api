import { InvalidInputException } from '@src/common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '@src/common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '@src/common/exceptions/state-conflict.exception.js';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createIngredient } from '@test/support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import type {
  IngredientGroup,
  IncompatibilityRule,
} from '@src/mongo/models.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import { IncompatibilityRulesService } from '@src/recipes/incompatibility-rules.service.js';

const tofu = 'a1a2d3e4-0000-4000-8000-000000000001';
const spinach = 'a1a2d3e4-0000-4000-8000-000000000002';
const greens = 'b1a2d3e4-0000-4000-8000-000000000001';
const REASON = 'Oxalat cản hấp thu canxi';

describe('IncompatibilityRulesService', () => {
  let app: INestApplication;
  let mongo: MongoService;
  let service: IncompatibilityRulesService;

  const groups = () =>
    mongo.connection.model<IngredientGroup>('IngredientGroup');
  const rules = () =>
    mongo.connection.model<IncompatibilityRule>('IncompatibilityRule');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('rules'))],
      providers: [IncompatibilityRulesService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    service = app.get(IncompatibilityRulesService);
  });
  beforeEach(async () => {
    for (const collection of [
      'ingredients',
      'ingredient_groups',
      'incompatibility_rules',
    ]) {
      await mongo.connection.collections[collection].deleteMany({});
    }
    await createIngredient(mongo, { id: tofu, name: 'Đậu hũ' });
    await createIngredient(mongo, { id: spinach, name: 'Rau bina' });
    await groups().create({
      _id: greens,
      name: 'Rau giàu oxalat',
      ingredientIds: [],
    });
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('rejects a rule that names an id that does not exist', async () => {
    await expect(
      service.create({
        a: { kind: 'INGREDIENT', id: tofu },
        b: { kind: 'GROUP', id: 'b1a2d3e4-0000-4000-8000-000000000099' },
        reason: REASON,
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_REFERENCE' });
    expect(await rules().countDocuments()).toBe(0);
  });

  it('stores each side as an ingredient or a group', async () => {
    const rule = await service.create({
      a: { kind: 'INGREDIENT', id: tofu },
      b: { kind: 'GROUP', id: greens },
      reason: REASON,
    });

    expect(await rules().findOne({ _id: rule.id }).exec()).toMatchObject({
      aIngredientId: tofu,
      aGroupId: null,
      bIngredientId: null,
      bGroupId: greens,
      reason: REASON,
      source: null,
    });
    expect(rule.a).toEqual({ kind: 'INGREDIENT', id: tofu, name: 'Đậu hũ' });
    expect(rule.b).toEqual({
      kind: 'GROUP',
      id: greens,
      name: 'Rau giàu oxalat',
    });
  });

  it('rejects an ingredient paired with itself', async () => {
    await expect(
      service.create({
        a: { kind: 'INGREDIENT', id: tofu },
        b: { kind: 'INGREDIENT', id: tofu },
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(InvalidInputException);
    expect(await rules().countDocuments()).toBe(0);
  });

  it('rejects a pair that already has a rule, in either order', async () => {
    await service.create({
      a: { kind: 'INGREDIENT', id: tofu },
      b: { kind: 'GROUP', id: greens },
      reason: REASON,
    });

    await expect(
      service.create({
        a: { kind: 'GROUP', id: greens },
        b: { kind: 'INGREDIENT', id: tofu },
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(StateConflictException);
    expect(await rules().countDocuments()).toBe(1);
  });

  it('finds conflicts through group membership and names both sides', async () => {
    await groups().updateOne(
      { _id: greens },
      { $addToSet: { ingredientIds: spinach } },
    );
    const created = await service.create({
      a: { kind: 'INGREDIENT', id: tofu },
      b: { kind: 'GROUP', id: greens },
      reason: REASON,
    });

    await expect(service.findConflicts([tofu, spinach])).resolves.toEqual([
      {
        ruleId: created.id,
        reason: REASON,
        source: null,
        a: { id: tofu, name: 'Đậu hũ' },
        b: { id: spinach, name: 'Rau bina' },
      },
    ]);
  });

  it('skips the database for fewer than two ingredients', async () => {
    await expect(service.findConflicts([tofu])).resolves.toEqual([]);
  });

  it('returns empty array when two or more ingredients have no conflicts', async () => {
    await expect(service.findConflicts([tofu, spinach])).resolves.toEqual([]);
  });

  it('lists rules newest first, updates rules, and removes rules', async () => {
    const first = await service.create({
      a: { kind: 'INGREDIENT', id: tofu },
      b: { kind: 'INGREDIENT', id: spinach },
      reason: 'Lý do 1',
      source: 'Sách dinh dưỡng',
    });
    const second = await service.create({
      a: { kind: 'GROUP', id: greens },
      b: { kind: 'GROUP', id: greens },
      reason: 'Lý do 2',
    });

    const page = await service.findAll({ page: 1, limit: 10 });
    expect(page.meta.totalItems).toBe(2);
    expect(page.items.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(page.items[1].source).toBe('Sách dinh dưỡng');

    // Updating a rule keeping the same pair is allowed and clears optional source
    const updated = await service.update(first.id, {
      a: { kind: 'INGREDIENT', id: spinach },
      b: { kind: 'INGREDIENT', id: tofu },
      reason: 'Lý do mới',
    });
    expect(updated.reason).toBe('Lý do mới');
    expect(updated.source).toBeNull();

    // Updating a rule to collide with another existing rule fails
    await expect(
      service.update(first.id, {
        a: { kind: 'GROUP', id: greens },
        b: { kind: 'GROUP', id: greens },
        reason: 'Trùng',
      }),
    ).rejects.toBeInstanceOf(StateConflictException);

    // Updating missing rule throws 404
    const missingRuleId = 'c1a2d3e4-0000-4000-8000-000000000099';
    await expect(
      service.update(missingRuleId, {
        a: { kind: 'INGREDIENT', id: tofu },
        b: { kind: 'GROUP', id: greens },
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);

    await service.remove(first.id);
    expect(await rules().countDocuments()).toBe(1);

    await expect(service.remove(first.id)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it('ignores group members not present in the queried ingredient set', async () => {
    const extra = 'a1a2d3e4-0000-4000-8000-000000000003';
    await createIngredient(mongo, { id: extra, name: 'Cải xoăn' });
    await groups().updateOne(
      { _id: greens },
      { $addToSet: { ingredientIds: { $each: [spinach, extra] } } },
    );
    await service.create({
      a: { kind: 'INGREDIENT', id: tofu },
      b: { kind: 'GROUP', id: greens },
      reason: REASON,
    });

    const conflicts = await service.findConflicts([tofu, spinach]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].b.id).toBe(spinach);
  });
});
