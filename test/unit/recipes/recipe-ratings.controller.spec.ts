import type { Response } from 'express';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '../../../src/auth-core/auth.types.js';
import { UserRole } from '../../../src/mongo/models.js';
import { RecipeRatingsController } from '../../../src/recipes/recipe-ratings.controller.js';
import type { RecipeRatingsService } from '../../../src/recipes/recipe-ratings.service.js';

function mockResponse() {
  const setHeader = vi.fn();
  return { res: { setHeader } as unknown as Response, setHeader };
}

describe('RecipeRatingsController', () => {
  const userId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
  const recipeId = 'd1a2d3e4-0000-4000-8000-000000000001';
  const req = {
    user: { sub: userId, username: 'rater', role: UserRole.USER },
  } as AuthenticatedRequest;

  let ratings: DeepMockProxy<RecipeRatingsService>;
  let controller: RecipeRatingsController;

  beforeEach(() => {
    ratings = mockDeep<RecipeRatingsService>();
    controller = new RecipeRatingsController(ratings);
  });

  it('delegates summary without private cache header', async () => {
    const summary = { recipeId, ratingCount: 2, averageRating: 4.5 };
    ratings.summary.mockResolvedValue(summary);

    await expect(controller.summary(recipeId)).resolves.toBe(summary);
    expect(ratings.summary).toHaveBeenCalledWith(recipeId);
  });

  it('delegates mine, set, and remove with private no-store cache headers', async () => {
    const mine = { recipeId, ratingCount: 1, averageRating: 5, myRating: 5 };
    const removed = {
      recipeId,
      ratingCount: 0,
      averageRating: null,
      myRating: null,
    };
    ratings.mine.mockResolvedValue(mine);
    ratings.set.mockResolvedValueOnce(mine).mockResolvedValueOnce(removed);

    const mineRes = mockResponse();
    await expect(controller.mine(recipeId, req, mineRes.res)).resolves.toBe(
      mine,
    );
    expect(mineRes.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(ratings.mine).toHaveBeenCalledWith(recipeId, userId);

    const setRes = mockResponse();
    await expect(
      controller.set(recipeId, req, { value: 5 }, setRes.res),
    ).resolves.toBe(mine);
    expect(setRes.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(ratings.set).toHaveBeenNthCalledWith(1, recipeId, userId, 5);

    const removeRes = mockResponse();
    await expect(controller.remove(recipeId, req, removeRes.res)).resolves.toBe(
      removed,
    );
    expect(removeRes.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(ratings.set).toHaveBeenNthCalledWith(2, recipeId, userId, null);
  });
});
