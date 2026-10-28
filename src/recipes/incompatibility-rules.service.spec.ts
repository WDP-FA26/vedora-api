import { BadRequestException, ConflictException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createIngredient } from '../../test/fixtures';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db';
import { MongoModule } from '../mongo/mongo.module';
import type { IngredientGroup, IncompatibilityRule } from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';
import { IncompatibilityRulesService } from './incompatibility-rules.service';

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
  const members = () => mongo.connection.model('IngredientGroupMember');

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
      'ingredient_group_members',
      'incompatibility_rules',
    ]) {
      await mongo.db.collection(collection).deleteMany({});
    }
    await createIngredient(mongo, { id: tofu, name: 'Đậu hũ' });
    await createIngredient(mongo, { id: spinach, name: 'Rau bina' });
    await groups().create({ _id: greens, name: 'Rau giàu oxalat' });
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
    ).rejects.toMatchObject({ response: { code: 'UNKNOWN_REFERENCE' } });
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
    ).rejects.toBeInstanceOf(BadRequestException);
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
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await rules().countDocuments()).toBe(1);
  });

  it('finds conflicts through group membership and names both sides', async () => {
    await members().create({ groupId: greens, ingredientId: spinach });
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
});
