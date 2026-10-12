import {
  AnimalLabel,
  Prisma,
  VeganStatus,
  VegetarianStatus,
} from '@prisma/client';
import type { IngredientSafetyInputDto } from './dto/ingredient.dto';
import { badRequest } from './recipe-errors';

export const safetyFields = [
  'active',
  'vegetarianStatus',
  'veganStatus',
  'animalLabels',
  'allergenLabels',
  'mayContainAllergens',
  'compositionComplete',
  'allergensComplete',
  'classificationSource',
  'classificationReason',
] as const;
export function hasSafetyInput(dto: IngredientSafetyInputDto) {
  return safetyFields.some((key) => dto[key] !== undefined);
}

export function safetyData(
  dto: IngredientSafetyInputDto,
  current?: Prisma.IngredientGetPayload<Record<string, never>>,
) {
  const value = {
    active: dto.active ?? current?.active ?? true,
    vegetarianStatus:
      dto.vegetarianStatus ??
      current?.vegetarianStatus ??
      VegetarianStatus.UNKNOWN,
    veganStatus: dto.veganStatus ?? current?.veganStatus ?? VeganStatus.UNKNOWN,
    animalLabels: dto.animalLabels ?? current?.animalLabels ?? [],
    allergenLabels: dto.allergenLabels ?? current?.allergenLabels ?? [],
    mayContainAllergens:
      dto.mayContainAllergens ?? current?.mayContainAllergens ?? [],
    compositionComplete:
      dto.compositionComplete ?? current?.compositionComplete ?? false,
    allergensComplete:
      dto.allergensComplete ?? current?.allergensComplete ?? false,
    classificationSource:
      dto.classificationSource ?? current?.classificationSource ?? null,
    classificationReason:
      dto.classificationReason ?? current?.classificationReason ?? null,
  };
  if (
    hasSafetyInput(dto) &&
    (!dto.classificationSource || !dto.classificationReason)
  )
    throw badRequest(
      'CLASSIFICATION_SOURCE_REQUIRED',
      'Provide source and reason when changing safety metadata',
    );
  const forbidden: AnimalLabel[] = [
    AnimalLabel.MEAT,
    AnimalLabel.FISH,
    AnimalLabel.SEAFOOD,
    AnimalLabel.SLAUGHTER_DERIVED,
  ];
  if (
    value.vegetarianStatus === VegetarianStatus.ALLOWED &&
    value.animalLabels.some((label) => forbidden.includes(label))
  )
    throw badRequest(
      'INVALID_CLASSIFICATION',
      'Slaughter-derived ingredients cannot be Vegetarian',
    );
  if (
    value.veganStatus === VeganStatus.VEGAN &&
    (value.vegetarianStatus !== VegetarianStatus.ALLOWED ||
      value.animalLabels.length > 0)
  )
    throw badRequest(
      'INVALID_CLASSIFICATION',
      'Verified Vegan ingredients must be Vegetarian and have no animal labels',
    );
  if (value.allergensComplete && !value.compositionComplete)
    throw badRequest(
      'INVALID_CLASSIFICATION',
      'Complete allergen information requires complete composition',
    );
  return value;
}
