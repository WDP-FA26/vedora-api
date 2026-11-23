import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  MAX_AVOIDED_GROUPS,
  MAX_AVOIDED_INGREDIENTS,
  SaveDietaryRestrictionsDto,
  SaveNutritionProfileDto,
  WeightCheckInDto,
} from '../../../src/recipes/dto/dietary.dto.js';
import {
  ActivityLevel,
  BiologicalSex,
  BodyFeeling,
  NutritionGoal,
} from '../../../src/mongo/models.js';
import {
  MAX_ALIASES,
  MAX_NAME_LENGTH,
  SaveIncompatibilityRuleDto,
  SaveIngredientDto,
  SaveIngredientGroupDto,
} from '../../../src/recipes/dto/ingredient.dto.js';
import {
  RecipeCatalogQueryDto,
  totalMinutes,
} from '../../../src/recipes/dto/recipe-catalog.dto.js';
import { SetRecipeRatingDto } from '../../../src/recipes/dto/recipe-rating.dto.js';
import {
  CheckConflictsDto,
  type RecipeDetailDto,
  SaveRecipeDto,
  toRecipeCard,
} from '../../../src/recipes/dto/recipe.dto.js';

const uuid = (n: number) =>
  `a1a2d3e4-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('Recipes DTOs', () => {
  describe('SaveDietaryRestrictionsDto', () => {
    it('accepts valid unique UUID v4 arrays and natural-language allergyNote', async () => {
      const dto = plainToInstance(SaveDietaryRestrictionsDto, {
        ingredientIds: [uuid(1)],
        groupIds: [uuid(2)],
        allergyNote: '  Dị ứng đậu phộng và mè đen  ',
      });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.allergyNote).toBe('Dị ứng đậu phộng và mè đen');
    });

    it('rejects duplicate, non-UUID, or oversized arrays', async () => {
      expect(
        await validate(
          plainToInstance(SaveDietaryRestrictionsDto, {
            ingredientIds: [uuid(1), uuid(1)],
            groupIds: [],
          }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(SaveDietaryRestrictionsDto, {
            ingredientIds: ['bad-id'],
            groupIds: [],
          }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(SaveDietaryRestrictionsDto, {
            ingredientIds: Array.from(
              { length: MAX_AVOIDED_INGREDIENTS + 1 },
              (_, i) => uuid(i + 1),
            ),
            groupIds: Array.from({ length: MAX_AVOIDED_GROUPS + 1 }, (_, i) =>
              uuid(i + 1),
            ),
          }),
        ),
      ).not.toHaveLength(0);
    });
  });

  describe('SaveNutritionProfileDto & WeightCheckInDto', () => {
    it('validates Asian BMI profile bounds and weight check-in fields', async () => {
      const validProfile = plainToInstance(SaveNutritionProfileDto, {
        heightCm: 162,
        weightKg: 54.5,
        targetWeightKg: 52,
        birthYear: 1998,
        biologicalSex: BiologicalSex.FEMALE,
        activityLevel: ActivityLevel.LIGHT,
        nutritionGoal: NutritionGoal.MAINTAIN,
      });
      expect(await validate(validProfile)).toHaveLength(0);

      const badProfile = plainToInstance(SaveNutritionProfileDto, {
        heightCm: 80,
        weightKg: 10,
      });
      expect(await validate(badProfile)).not.toHaveLength(0);

      const validCheckIn = plainToInstance(WeightCheckInDto, {
        weightKg: 54.2,
        date: '2026-11-21',
        feeling: BodyFeeling.ENERGETIC,
        note: '  Ngủ ngon  ',
      });
      expect(await validate(validCheckIn)).toHaveLength(0);
      expect(validCheckIn.note).toBe('Ngủ ngon');

      const badCheckIn = plainToInstance(WeightCheckInDto, {
        weightKg: 54.2,
        date: '21-11-2026',
      });
      expect(await validate(badCheckIn)).not.toHaveLength(0);
    });
  });

  describe('Ingredient & Rule DTOs', () => {
    it('trims ingredient name and aliases and validates bounds', async () => {
      const dto = plainToInstance(SaveIngredientDto, {
        name: '  Đậu hũ  ',
        aliases: ['  Tofu ', 'Đậu phụ'],
        groupIds: [uuid(1)],
      });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.name).toBe('Đậu hũ');
      expect(dto.aliases).toEqual(['Tofu', 'Đậu phụ']);

      expect(
        await validate(
          plainToInstance(SaveIngredientDto, {
            name: '   ',
            aliases: Array.from({ length: MAX_ALIASES + 1 }, (_, i) => `a${i}`),
          }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(SaveIngredientDto, {
            name: 'a'.repeat(MAX_NAME_LENGTH + 1),
            aliases: [''],
            groupIds: [uuid(1), uuid(1)],
          }),
        ),
      ).not.toHaveLength(0);
    });

    it('handles non-string/non-array transform inputs gracefully during validation', async () => {
      const nonString = plainToInstance(SaveIngredientDto, {
        name: 123,
        aliases: 'not-an-array',
      });
      expect(await validate(nonString)).not.toHaveLength(0);
    });

    it('validates SaveIngredientGroupDto', async () => {
      const valid = plainToInstance(SaveIngredientGroupDto, {
        name: '  Rau xanh ',
        description: '  Nhóm rau  ',
        dietary: true,
        ingredientIds: [uuid(1)],
      });
      expect(await validate(valid)).toHaveLength(0);
      expect(valid.name).toBe('Rau xanh');
      expect(valid.description).toBe('Nhóm rau');

      expect(
        await validate(
          plainToInstance(SaveIngredientGroupDto, {
            name: '',
            dietary: 'yes',
            ingredientIds: ['bad'],
          }),
        ),
      ).not.toHaveLength(0);
    });

    it('validates SaveIncompatibilityRuleDto', async () => {
      const valid = plainToInstance(SaveIncompatibilityRuleDto, {
        a: { kind: 'INGREDIENT', id: uuid(1) },
        b: { kind: 'GROUP', id: uuid(2) },
        reason: '  Kỵ nhau  ',
        source: '  Viện Dinh Dưỡng ',
      });
      expect(await validate(valid)).toHaveLength(0);
      expect(valid.reason).toBe('Kỵ nhau');
      expect(valid.source).toBe('Viện Dinh Dưỡng');

      expect(
        await validate(
          plainToInstance(SaveIncompatibilityRuleDto, {
            a: { kind: 'OTHER', id: 'bad' },
            b: { kind: 'GROUP', id: uuid(2) },
            reason: '   ',
          }),
        ),
      ).not.toHaveLength(0);
    });
  });

  describe('RecipeCatalogQueryDto & totalMinutes', () => {
    it('transforms query params and applies defaults', async () => {
      const defaults = plainToInstance(RecipeCatalogQueryDto, {});
      expect(await validate(defaults)).toHaveLength(0);
      expect(defaults.suitableForMe).toBe(false);

      const valid = plainToInstance(RecipeCatalogQueryDto, {
        q: '  đậu hũ  ',
        maxMinutes: '45',
        suitableForMe: 'true',
      });
      expect(await validate(valid)).toHaveLength(0);
      expect(valid.q).toBe('đậu hũ');
      expect(valid.maxMinutes).toBe(45);
      expect(valid.suitableForMe).toBe(true);

      const falseBool = plainToInstance(RecipeCatalogQueryDto, {
        suitableForMe: 'false',
      });
      expect(await validate(falseBool)).toHaveLength(0);
      expect(falseBool.suitableForMe).toBe(false);
    });

    it('rejects whitespace-only q, negative/over-limit maxMinutes, or invalid suitableForMe', async () => {
      expect(
        await validate(
          plainToInstance(RecipeCatalogQueryDto, {
            q: '   ',
            maxMinutes: 'abc',
            suitableForMe: 'yes',
          }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(RecipeCatalogQueryDto, {
            q: 'a'.repeat(101),
            maxMinutes: 2881,
          }),
        ),
      ).not.toHaveLength(0);
    });

    it('computes totalMinutes across null and non-null combinations', () => {
      expect(totalMinutes({ prepMinutes: null, cookMinutes: null })).toBeNull();
      expect(totalMinutes({ prepMinutes: 10, cookMinutes: null })).toBe(10);
      expect(totalMinutes({ prepMinutes: null, cookMinutes: 25 })).toBe(25);
      expect(totalMinutes({ prepMinutes: 10, cookMinutes: 25 })).toBe(35);
    });
  });

  describe('SaveRecipeDto, CheckConflictsDto, toRecipeCard & SetRecipeRatingDto', () => {
    it('validates SaveRecipeDto and trims strings', async () => {
      const dto = plainToInstance(SaveRecipeDto, {
        title: '  Đậu hũ sốt cà  ',
        description: '  Món chay ngon  ',
        imageUrl: ' https://res.cloudinary.com/demo/image/upload/dish.jpg ',
        servings: 2,
        prepMinutes: 10,
        cookMinutes: 15,
        ingredients: [
          {
            ingredientId: uuid(1),
            quantity: 200.5,
            unit: ' g ',
            note: ' cắt nhỏ ',
          },
        ],
        steps: ['  Rán đậu  ', '  Sốt cà '],
        postId: uuid(9),
      });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.title).toBe('Đậu hũ sốt cà');
      expect(dto.ingredients[0].unit).toBe('g');
      expect(dto.steps).toEqual(['Rán đậu', 'Sốt cà']);
    });

    it('rejects invalid SaveRecipeDto fields (non-https URL, duplicate ingredient, bad servings, empty steps)', async () => {
      const bad = plainToInstance(SaveRecipeDto, {
        title: '  ',
        imageUrl: 'http://insecure.example.com/a.jpg',
        servings: 0,
        prepMinutes: -1,
        cookMinutes: 9999,
        ingredients: [
          { ingredientId: uuid(1), quantity: 0 },
          { ingredientId: uuid(1) },
        ],
        steps: ['  '],
        postId: 'not-uuid',
      });
      expect(await validate(bad)).not.toHaveLength(0);

      const nonArray = plainToInstance(SaveRecipeDto, {
        title: 123,
        servings: 1,
        ingredients: [],
        steps: 'not-array',
      });
      expect(await validate(nonArray)).not.toHaveLength(0);
    });

    it('validates CheckConflictsDto and SetRecipeRatingDto', async () => {
      expect(
        await validate(
          plainToInstance(CheckConflictsDto, {
            ingredientIds: [uuid(1), uuid(2)],
          }),
        ),
      ).toHaveLength(0);
      expect(
        await validate(
          plainToInstance(CheckConflictsDto, {
            ingredientIds: [uuid(1), uuid(1)],
          }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(plainToInstance(SetRecipeRatingDto, { value: 4 })),
      ).toHaveLength(0);
      expect(
        await validate(plainToInstance(SetRecipeRatingDto, { value: 0 })),
      ).not.toHaveLength(0);
      expect(
        await validate(plainToInstance(SetRecipeRatingDto, { value: 6 })),
      ).not.toHaveLength(0);
      expect(
        await validate(plainToInstance(SetRecipeRatingDto, { value: 4.5 })),
      ).not.toHaveLength(0);
    });

    it('strips detail-only properties in toRecipeCard', () => {
      const detail: RecipeDetailDto = {
        id: uuid(10),
        title: 'Đậu hũ',
        imageUrl: null,
        servings: 2,
        prepMinutes: 10,
        cookMinutes: 5,
        ingredientCount: 1,
        conflictCount: 0,
        conflicts: [],
        post: null,
        updatedAt: new Date('2026-10-01T00:00:00Z'),
        description: 'Mô tả',
        steps: ['Nấu'],
        ingredients: [
          {
            ingredientId: uuid(1),
            name: 'Đậu hũ',
            quantity: 100,
            unit: 'g',
            note: null,
          },
        ],
      };

      const card = toRecipeCard(detail);
      expect(card).not.toHaveProperty('description');
      expect(card).not.toHaveProperty('steps');
      expect(card).not.toHaveProperty('ingredients');
      expect(card.title).toBe('Đậu hũ');
    });
  });
});
