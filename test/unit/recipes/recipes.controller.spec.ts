import type { Response } from 'express';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type {
  AuthenticatedRequest,
  OptionalAuthenticatedRequest,
} from '@src/auth-core/auth.types.js';
import { UserRole } from '@src/mongo/models.js';
import type { RecipeCatalogService } from '@src/recipes/recipe-catalog.service.js';
import type { RecipeFavoritesService } from '@src/recipes/recipe-favorites.service.js';
import { RecipesController } from '@src/recipes/recipes.controller.js';

function mockResponse() {
  const vary = vi.fn();
  const setHeader = vi.fn();
  return {
    res: { vary, setHeader } as unknown as Response,
    vary,
    setHeader,
  };
}

describe('RecipesController', () => {
  const userId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
  const recipeId = 'd1a2d3e4-0000-4000-8000-000000000001';
  const authReq = {
    user: { sub: userId, username: 'chef', role: UserRole.USER },
  } as AuthenticatedRequest;
  const guestReq = {} as OptionalAuthenticatedRequest;

  let catalog: DeepMockProxy<RecipeCatalogService>;
  let favorites: DeepMockProxy<RecipeFavoritesService>;
  let controller: RecipesController;

  beforeEach(() => {
    catalog = mockDeep<RecipeCatalogService>();
    favorites = mockDeep<RecipeFavoritesService>();
    controller = new RecipesController(catalog, favorites);
  });

  describe('list', () => {
    it('sets Vary: Authorization without private Cache-Control for guests', async () => {
      const { res, vary, setHeader } = mockResponse();
      const query = { page: 1, limit: 20, suitableForMe: false };
      const expected = {
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
      catalog.list.mockResolvedValue(expected);

      await expect(controller.list(query, guestReq, res)).resolves.toBe(
        expected,
      );
      expect(vary).toHaveBeenCalledWith('Authorization');
      expect(setHeader).not.toHaveBeenCalled();
      expect(catalog.list).toHaveBeenCalledWith(query, undefined);
    });

    it('sets Cache-Control: private, no-store for authenticated users', async () => {
      const { res, vary, setHeader } = mockResponse();
      const query = { page: 1, limit: 10, suitableForMe: true };
      const expected = {
        items: [],
        meta: {
          page: 1,
          limit: 10,
          totalItems: 0,
          totalPages: 0,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      };
      catalog.list.mockResolvedValue(expected);

      await expect(controller.list(query, authReq, res)).resolves.toBe(
        expected,
      );
      expect(vary).toHaveBeenCalledWith('Authorization');
      expect(setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'private, no-store',
      );
      expect(catalog.list).toHaveBeenCalledWith(query, userId);
    });
  });

  describe('favorites', () => {
    it('lists favorites with private no-store header', async () => {
      const { res, setHeader } = mockResponse();
      const query = { page: 1, limit: 20 };
      const expected = {
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
      favorites.list.mockResolvedValue(expected);

      await expect(controller.favoritesList(query, authReq, res)).resolves.toBe(
        expected,
      );
      expect(setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'private, no-store',
      );
      expect(favorites.list).toHaveBeenCalledWith(userId, query);
    });

    it('saves a favorite with isFavorite=true', async () => {
      const { res, setHeader } = mockResponse();
      const expected = { recipeId, isFavorite: true };
      favorites.set.mockResolvedValue(expected);

      await expect(
        controller.saveFavorite(recipeId, authReq, {}, res),
      ).resolves.toBe(expected);
      expect(setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'private, no-store',
      );
      expect(favorites.set).toHaveBeenCalledWith(recipeId, userId, true);
    });

    it('removes a favorite with isFavorite=false', async () => {
      const { res, setHeader } = mockResponse();
      const expected = { recipeId, isFavorite: false };
      favorites.set.mockResolvedValue(expected);

      await expect(
        controller.removeFavorite(recipeId, authReq, {}, res),
      ).resolves.toBe(expected);
      expect(setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'private, no-store',
      );
      expect(favorites.set).toHaveBeenCalledWith(recipeId, userId, false);
    });
  });

  describe('findOne', () => {
    it('omits private Cache-Control for guests and sets it for authenticated callers', async () => {
      const detail = {
        id: recipeId,
        title: 'Đậu hũ sốt cà',
        imageUrl: null,
        servings: 2,
        prepMinutes: 10,
        cookMinutes: 5,
        totalMinutes: 15,
        ingredientCount: 1,
        conflictCount: 0,
        conflicts: [],
        post: null,
        updatedAt: new Date(),
        description: null,
        steps: ['Nấu'],
        ingredients: [],
        isFavorite: false,
      };
      catalog.findOne.mockResolvedValue(detail);

      const guest = mockResponse();
      await expect(
        controller.findOne(recipeId, guestReq, guest.res),
      ).resolves.toBe(detail);
      expect(guest.vary).toHaveBeenCalledWith('Authorization');
      expect(guest.setHeader).not.toHaveBeenCalled();
      expect(catalog.findOne).toHaveBeenCalledWith(recipeId, undefined);

      const auth = mockResponse();
      await expect(
        controller.findOne(recipeId, authReq, auth.res),
      ).resolves.toBe(detail);
      expect(auth.vary).toHaveBeenCalledWith('Authorization');
      expect(auth.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'private, no-store',
      );
      expect(catalog.findOne).toHaveBeenLastCalledWith(recipeId, userId);
    });
  });
});
