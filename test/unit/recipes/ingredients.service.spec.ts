import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InvalidInputException } from '@src/common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '@src/common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '@src/common/exceptions/state-conflict.exception.js';
import type { IngredientGroup } from '@src/mongo/models.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import { IngredientsService } from '@src/recipes/ingredients.service.js';
import { createRecipe } from '@test/support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';

describe('IngredientsService', () => {
  let app: INestApplication;
  let mongo: MongoService;
  let service: IngredientsService;

  const groups = () =>
    mongo.connection.model<IngredientGroup>('IngredientGroup');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('ingredients'))],
      providers: [IngredientsService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    service = app.get(IngredientsService);
  });

  beforeEach(async () => {
    for (const collection of [
      'ingredients',
      'ingredient_groups',
      'incompatibility_rules',
      'recipes',
    ]) {
      await mongo.connection.collections[collection].deleteMany({});
    }
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('creates, lists with recipeCount and sorted groups, updates group memberships, and removes unused ingredients', async () => {
    const g1 = await service.createGroup({ name: 'Nhóm B', dietary: true });
    const g2 = await service.createGroup({
      name: 'Nhóm A',
      description: 'Mô tả',
    });

    const tofu = await service.create({
      name: 'Đậu hũ',
      aliases: ['Tofu'],
      groupIds: [g1.id, g2.id],
    });
    expect(tofu.groups.map((g) => g.name)).toEqual(['Nhóm A', 'Nhóm B']);
    expect(tofu.aliases).toEqual(['Tofu']);
    expect(tofu.recipeCount).toBe(0);

    const sesame = await service.create({ name: 'Bơ mè' });
    await createRecipe(mongo, { title: 'Đậu hũ mè' }, [tofu.id, sesame.id]);

    const list = await service.findAll({ page: 1, limit: 10 });
    expect(list.items.map((i) => i.name)).toEqual(['Bơ mè', 'Đậu hũ']);
    expect(list.items.find((i) => i.id === tofu.id)?.recipeCount).toBe(1);

    // Update tofu: keep only g1, clear aliases
    const updated = await service.update(tofu.id, {
      name: 'Đậu hũ non',
      groupIds: [g1.id],
    });
    expect(updated.name).toBe('Đậu hũ non');
    expect(updated.aliases).toEqual([]);
    expect(updated.groups.map((g) => g.id)).toEqual([g1.id]);

    // Update sesame with no groups
    await service.update(sesame.id, { name: 'Mè trắng' });

    // Deleting an ingredient used in a recipe fails with INGREDIENT_IN_USE
    await expect(service.remove(tofu.id)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof StateConflictException &&
        err.code === 'INGREDIENT_IN_USE',
    );

    const unused = await service.create({ name: 'Rau mùi' });
    await service.remove(unused.id);
    await expect(service.remove(unused.id)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it('rejects duplicate names and unknown references on ingredients', async () => {
    const g = await service.createGroup({ name: 'Nhóm X' });
    const ing = await service.create({ name: 'Đậu hũ' });
    await service.create({ name: 'Nấm' });

    await expect(service.create({ name: 'Đậu hũ' })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof StateConflictException && err.code === 'NAME_TAKEN',
    );

    await expect(
      service.update(ing.id, { name: 'Nấm', groupIds: [g.id] }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof StateConflictException && err.code === 'NAME_TAKEN',
    );

    await expect(
      service.create({
        name: 'Cà rốt',
        groupIds: ['b1a2d3e4-0000-4000-8000-000000000099'],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof InvalidInputException &&
        err.code === 'UNKNOWN_REFERENCE',
    );

    await expect(
      service.update('a1a2d3e4-0000-4000-8000-000000000099', {
        name: 'Không tồn tại',
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('manages ingredient groups CRUD, validation, and conflict handling', async () => {
    const tofu = await service.create({ name: 'Đậu hũ' });
    const carrot = await service.create({ name: 'Cà rốt' });

    const g1 = await service.createGroup({
      name: 'Nhóm Củ',
      description: 'Các loại củ',
      dietary: true,
      ingredientIds: [tofu.id, carrot.id],
    });
    expect(g1.ingredients.map((i) => i.name)).toEqual(['Cà rốt', 'Đậu hũ']);
    expect(g1.dietary).toBe(true);

    const g2 = await service.createGroup({ name: 'Nhóm Khác' });
    const allGroups = await service.findAllGroups({ page: 1, limit: 10 });
    expect(allGroups.items.map((g) => g.name)).toEqual([
      'Nhóm Củ',
      'Nhóm Khác',
    ]);

    const updated = await service.updateGroup(g1.id, {
      name: 'Nhóm Củ Quả',
      ingredientIds: [carrot.id],
    });
    expect(updated.description).toBeNull();
    expect(updated.dietary).toBe(false);
    expect(updated.ingredients.map((i) => i.id)).toEqual([carrot.id]);

    await expect(service.createGroup({ name: 'Nhóm Khác' })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof StateConflictException && err.code === 'NAME_TAKEN',
    );

    await expect(
      service.createGroup({
        name: 'Nhóm Lỗi',
        ingredientIds: ['a1a2d3e4-0000-4000-8000-000000000099'],
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_REFERENCE' });

    await expect(
      service.updateGroup('b1a2d3e4-0000-4000-8000-000000000099', {
        name: 'Missing',
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);

    // Tolerates dangling ingredient id in DB group document
    await groups().updateOne(
      { _id: g2.id },
      { $set: { ingredientIds: ['a1a2d3e4-0000-4000-8000-000000000099'] } },
    );
    const listed = await service.findAllGroups({ page: 1, limit: 10 });
    expect(listed.items.find((g) => g.id === g2.id)?.ingredients).toEqual([]);

    await service.removeGroup(g1.id);
    await expect(service.removeGroup(g1.id)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });
});
