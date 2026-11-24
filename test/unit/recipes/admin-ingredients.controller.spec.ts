import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import {
  AdminIncompatibilityRulesController,
  AdminIngredientGroupsController,
  AdminIngredientsController,
} from '@src/recipes/admin-ingredients.controller.js';
import type { IncompatibilityRulesService } from '@src/recipes/incompatibility-rules.service.js';
import type { IngredientsService } from '@src/recipes/ingredients.service.js';

const emptyMeta = {
  page: 1,
  limit: 20,
  totalItems: 0,
  totalPages: 0,
  hasNextPage: false,
  hasPreviousPage: false,
};

describe('AdminIngredients controllers', () => {
  let ingredients: DeepMockProxy<IngredientsService>;
  let rules: DeepMockProxy<IncompatibilityRulesService>;

  beforeEach(() => {
    ingredients = mockDeep<IngredientsService>();
    rules = mockDeep<IncompatibilityRulesService>();
  });

  describe('AdminIngredientsController', () => {
    let controller: AdminIngredientsController;
    const id = 'a1a2d3e4-0000-4000-8000-000000000001';

    beforeEach(() => {
      controller = new AdminIngredientsController(ingredients);
    });

    it('delegates findAll, create, update, and remove', async () => {
      const page = { items: [], meta: emptyMeta };
      const dto = { name: 'Đậu hũ', aliases: ['Tofu'] };
      const saved = {
        id,
        name: 'Đậu hũ',
        aliases: ['Tofu'],
        groups: [],
        recipeCount: 0,
        createdAt: new Date(),
      };
      ingredients.findAll.mockResolvedValue(page);
      ingredients.create.mockResolvedValue(saved);
      ingredients.update.mockResolvedValue(saved);
      ingredients.remove.mockResolvedValue(undefined);

      await expect(controller.findAll({ page: 1, limit: 20 })).resolves.toBe(
        page,
      );
      await expect(controller.create(dto)).resolves.toBe(saved);
      await expect(controller.update(id, dto)).resolves.toBe(saved);
      await expect(controller.remove(id)).resolves.toBeUndefined();

      expect(ingredients.findAll).toHaveBeenCalledWith({ page: 1, limit: 20 });
      expect(ingredients.create).toHaveBeenCalledWith(dto);
      expect(ingredients.update).toHaveBeenCalledWith(id, dto);
      expect(ingredients.remove).toHaveBeenCalledWith(id);
    });
  });

  describe('AdminIngredientGroupsController', () => {
    let controller: AdminIngredientGroupsController;
    const id = 'b1a2d3e4-0000-4000-8000-000000000001';

    beforeEach(() => {
      controller = new AdminIngredientGroupsController(ingredients);
    });

    it('delegates findAll, create, update, and remove', async () => {
      const page = { items: [], meta: emptyMeta };
      const dto = { name: 'Ngũ vị tân', dietary: true, ingredientIds: [] };
      const saved = {
        id,
        name: 'Ngũ vị tân',
        description: null,
        dietary: true,
        ingredients: [],
        createdAt: new Date(),
      };
      ingredients.findAllGroups.mockResolvedValue(page);
      ingredients.createGroup.mockResolvedValue(saved);
      ingredients.updateGroup.mockResolvedValue(saved);
      ingredients.removeGroup.mockResolvedValue(undefined);

      await expect(controller.findAll({ page: 1, limit: 20 })).resolves.toBe(
        page,
      );
      await expect(controller.create(dto)).resolves.toBe(saved);
      await expect(controller.update(id, dto)).resolves.toBe(saved);
      await expect(controller.remove(id)).resolves.toBeUndefined();

      expect(ingredients.findAllGroups).toHaveBeenCalledWith({
        page: 1,
        limit: 20,
      });
      expect(ingredients.createGroup).toHaveBeenCalledWith(dto);
      expect(ingredients.updateGroup).toHaveBeenCalledWith(id, dto);
      expect(ingredients.removeGroup).toHaveBeenCalledWith(id);
    });
  });

  describe('AdminIncompatibilityRulesController', () => {
    let controller: AdminIncompatibilityRulesController;
    const id = 'c1a2d3e4-0000-4000-8000-000000000001';

    beforeEach(() => {
      controller = new AdminIncompatibilityRulesController(rules);
    });

    it('delegates findAll, create, update, and remove', async () => {
      const page = { items: [], meta: emptyMeta };
      const dto = {
        a: {
          kind: 'INGREDIENT' as const,
          id: 'a1a2d3e4-0000-4000-8000-000000000001',
        },
        b: {
          kind: 'GROUP' as const,
          id: 'b1a2d3e4-0000-4000-8000-000000000001',
        },
        reason: 'Oxalat',
      };
      const saved = {
        id,
        a: { kind: 'INGREDIENT' as const, id: dto.a.id, name: 'Đậu hũ' },
        b: { kind: 'GROUP' as const, id: dto.b.id, name: 'Rau bina' },
        reason: 'Oxalat',
        source: null,
        createdAt: new Date(),
      };
      rules.findAll.mockResolvedValue(page);
      rules.create.mockResolvedValue(saved);
      rules.update.mockResolvedValue(saved);
      rules.remove.mockResolvedValue(undefined);

      await expect(controller.findAll({ page: 1, limit: 20 })).resolves.toBe(
        page,
      );
      await expect(controller.create(dto)).resolves.toBe(saved);
      await expect(controller.update(id, dto)).resolves.toBe(saved);
      await expect(controller.remove(id)).resolves.toBeUndefined();

      expect(rules.findAll).toHaveBeenCalledWith({ page: 1, limit: 20 });
      expect(rules.create).toHaveBeenCalledWith(dto);
      expect(rules.update).toHaveBeenCalledWith(id, dto);
      expect(rules.remove).toHaveBeenCalledWith(id);
    });
  });
});
