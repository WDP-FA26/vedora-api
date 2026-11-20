import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '../../../src/auth-core/auth.types.js';
import { UserRole } from '../../../src/mongo/models.js';
import { DietaryController } from '../../../src/recipes/dietary.controller.js';
import type { DietaryService } from '../../../src/recipes/dietary.service.js';

describe('DietaryController', () => {
  const userId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
  const req = {
    user: { sub: userId, username: 'diner', role: UserRole.USER },
  } as AuthenticatedRequest;

  let dietary: DeepMockProxy<DietaryService>;
  let controller: DietaryController;

  beforeEach(() => {
    dietary = mockDeep<DietaryService>();
    controller = new DietaryController(dietary);
  });

  it('delegates options, find, and replace to DietaryService', async () => {
    const opts = { ingredients: [], groups: [] };
    const restrictions = { ingredients: [], groups: [], liked: [], terms: [] };
    const dto = { ingredientIds: [], groupIds: [], likedIngredientIds: [] };

    dietary.options.mockResolvedValue(opts);
    dietary.find.mockResolvedValue(restrictions);
    dietary.replace.mockResolvedValue(restrictions);

    await expect(controller.options()).resolves.toBe(opts);
    await expect(controller.find(req)).resolves.toBe(restrictions);
    await expect(controller.replace(req, dto)).resolves.toBe(restrictions);

    expect(dietary.options).toHaveBeenCalledOnce();
    expect(dietary.find).toHaveBeenCalledWith(userId);
    expect(dietary.replace).toHaveBeenCalledWith(userId, dto);
  });
});
