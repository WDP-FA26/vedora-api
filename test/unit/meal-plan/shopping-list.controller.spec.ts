import type { Response } from 'express';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '../../../src/auth-core/auth.types.js';
import type { ShoppingListDto } from '../../../src/meal-plan/dto/shopping-list.dto.js';
import { ShoppingListController } from '../../../src/meal-plan/shopping-list.controller.js';
import type { ShoppingListService } from '../../../src/meal-plan/shopping-list.service.js';
import { UserRole, Weekday } from '../../../src/mongo/models.js';

describe('ShoppingListController', () => {
  const userId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
  const req = {
    user: { sub: userId, username: 'shopper', role: UserRole.USER },
  } as AuthenticatedRequest;

  let shopping: DeepMockProxy<ShoppingListService>;
  let controller: ShoppingListController;

  beforeEach(() => {
    shopping = mockDeep<ShoppingListService>();
    controller = new ShoppingListController(shopping);
  });

  it('sets private no-store cache headers and delegates to ShoppingListService', async () => {
    const setHeader = vi.fn();
    const res = { setHeader } as unknown as Response;
    const query = { days: [Weekday.MON, Weekday.TUE] };
    const expected: ShoppingListDto = {
      weekStart: '2026-11-16',
      days: [Weekday.MON, Weekday.TUE],
      quantityBasis: 'RECIPE_PER_OCCURRENCE',
      items: [],
    };
    shopping.get.mockResolvedValue(expected);

    await expect(controller.get(req, query, res)).resolves.toBe(expected);
    expect(setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(shopping.get).toHaveBeenCalledWith(userId, query);
  });
});
