import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '../../../src/auth-core/auth.types.js';
import type { CloudinaryService } from '../../../src/cloudinary/cloudinary.service.js';
import { UserRole } from '../../../src/mongo/models.js';
import { AdminRecipesController } from '../../../src/recipes/admin-recipes.controller.js';
import type { IncompatibilityRulesService } from '../../../src/recipes/incompatibility-rules.service.js';
import type { RecipesService } from '../../../src/recipes/recipes.service.js';
import type { RecipeDraftsService } from '../../../src/recipes/drafts/recipe-drafts.service.js';

describe('AdminRecipesController', () => {
  const adminId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
  const recipeId = 'd1a2d3e4-0000-4000-8000-000000000001';
  const req = {
    user: { sub: adminId, username: 'vedora.admin', role: UserRole.ADMIN },
  } as AuthenticatedRequest;

  let recipes: DeepMockProxy<RecipesService>;
  let rules: DeepMockProxy<IncompatibilityRulesService>;
  let cloudinary: DeepMockProxy<CloudinaryService>;
  let drafts: DeepMockProxy<RecipeDraftsService>;
  let controller: AdminRecipesController;

  beforeEach(() => {
    recipes = mockDeep<RecipesService>();
    rules = mockDeep<IncompatibilityRulesService>();
    cloudinary = mockDeep<CloudinaryService>();
    drafts = mockDeep<RecipeDraftsService>();
    controller = new AdminRecipesController(recipes, rules, cloudinary, drafts);
  });

  it('passes the admin and the source on to the draft service', async () => {
    const draft = { recipe: null, untranscribedVideos: 0 };
    drafts.create.mockResolvedValue(draft);

    await expect(
      controller.createDraft(req, { text: 'Đậu hũ sốt cà' }),
    ).resolves.toBe(draft);
    expect(drafts.create).toHaveBeenCalledWith(adminId, {
      text: 'Đậu hũ sốt cà',
    });
  });

  it('creates a signed recipe image upload', () => {
    const signed = {
      upload: {
        url: 'https://api.cloudinary.com/v1_1/demo/image/upload',
        fields: { signature: 'sig' },
        chunkSize: 5_000_000,
      },
      url: 'https://res.cloudinary.com/demo/image/upload/dish.webp',
    };
    cloudinary.signRecipeImageUpload.mockReturnValue(signed);

    expect(controller.createImageUpload()).toBe(signed);
    expect(cloudinary.signRecipeImageUpload).toHaveBeenCalledOnce();
  });

  it('lists recipes with pagination', async () => {
    const query = { page: 1, limit: 20 };
    const page = {
      items: [],
      meta: {
        page: 1,
        limit: 20,
        totalItems: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    };
    recipes.findAll.mockResolvedValue(page);

    await expect(controller.findAll(query)).resolves.toBe(page);
    expect(recipes.findAll).toHaveBeenCalledWith(query);
  });

  it('checks ingredient conflicts', async () => {
    const ids = ['a1a2d3e4-0000-4000-8000-000000000001'];
    rules.findConflicts.mockResolvedValue([]);

    await expect(controller.conflicts({ ingredientIds: ids })).resolves.toEqual(
      [],
    );
    expect(rules.findConflicts).toHaveBeenCalledWith(ids);
  });

  it('gets, creates, updates, and removes a recipe', async () => {
    const dto = {
      title: 'Đậu hũ sốt cà',
      servings: 2,
      ingredients: [{ ingredientId: 'a1a2d3e4-0000-4000-8000-000000000001' }],
      steps: ['Nấu'],
    };
    const detail = {
      id: recipeId,
      title: dto.title,
      imageUrl: null,
      servings: 2,
      prepMinutes: null,
      cookMinutes: null,
      ingredientCount: 1,
      conflictCount: 0,
      conflicts: [],
      post: null,
      updatedAt: new Date(),
      description: null,
      steps: dto.steps,
      ingredients: [],
    };
    recipes.findOne.mockResolvedValue(detail);
    recipes.create.mockResolvedValue(detail);
    recipes.update.mockResolvedValue(detail);
    recipes.remove.mockResolvedValue(undefined);

    await expect(controller.findOne(recipeId)).resolves.toBe(detail);
    expect(recipes.findOne).toHaveBeenCalledWith(recipeId);

    await expect(controller.create(req, dto)).resolves.toBe(detail);
    expect(recipes.create).toHaveBeenCalledWith(adminId, dto);

    await expect(controller.update(recipeId, dto)).resolves.toBe(detail);
    expect(recipes.update).toHaveBeenCalledWith(recipeId, dto);

    await expect(controller.remove(recipeId)).resolves.toBeUndefined();
    expect(recipes.remove).toHaveBeenCalledWith(recipeId);
  });
});
