import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '@src/auth-core/auth.types.js';
import { JwtAuthGuard } from '@src/auth-core/jwt-auth.guard.js';
import { PersonalSessionGuard } from '@src/auth-core/personal-session.guard.js';
import { UserRole } from '@src/mongo/models.js';
import { DietaryController } from '@src/recipes/dietary.controller.js';
import type { DietaryService } from '@src/recipes/dietary.service.js';

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

  it('requires JwtAuthGuard and PersonalSessionGuard on the controller', () => {
    const guards = Reflect.getMetadata('__guards__', DietaryController) as
      unknown[] | undefined;
    expect(guards).toEqual([JwtAuthGuard, PersonalSessionGuard]);
  });

  it('delegates options, find, and replace to DietaryService', async () => {
    const opts = { ingredients: [], groups: [] };
    const restrictions = { ingredients: [], groups: [], terms: [] };
    const dto = { ingredientIds: [], groupIds: [] };

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

  it('delegates findNutrition, saveNutrition, and checkInWeight to DietaryService', async () => {
    const profile = {
      heightCm: 165,
      weightKg: 60,
      targetWeightKg: null,
      birthYear: null,
      biologicalSex: null,
      activityLevel: null,
      nutritionGoal: null,
      bmi: 22,
      bmiCategory: null,
      suggestedGoal: null,
      effectiveGoal: null,
      idealWeightMinKg: 50.4,
      idealWeightMaxKg: 62.3,
      bmr: 1350,
      tdee: 1860,
      dailyCalorieTarget: 1860,
      dailyCalorieMin: 1580,
      dailyCalorieMax: 2140,
      safetyNote: null,
      history: [],
    };
    const saveDto = { heightCm: 165, weightKg: 60 };
    const checkInDto = { weightKg: 59.5 };

    dietary.findNutrition.mockResolvedValue(profile);
    dietary.saveNutrition.mockResolvedValue(profile);
    dietary.checkInWeight.mockResolvedValue(profile);

    await expect(controller.findNutrition(req)).resolves.toBe(profile);
    await expect(controller.saveNutrition(req, saveDto)).resolves.toBe(profile);
    await expect(controller.checkInWeight(req, checkInDto)).resolves.toBe(
      profile,
    );

    expect(dietary.findNutrition).toHaveBeenCalledWith(userId);
    expect(dietary.saveNutrition).toHaveBeenCalledWith(userId, saveDto);
    expect(dietary.checkInWeight).toHaveBeenCalledWith(userId, checkInDto);
  });
});
