import {
  AllergyAcknowledgement,
  DietMode,
  VeganStatus,
  VegetarianStatus,
} from '@prisma/client';
import type { DeepMockProxy } from 'vitest-mock-extended';
import type { PrismaService } from '../../src/prisma/prisma.service';

export const verifiedIngredientSafety = {
  active: true,
  vegetarianStatus: VegetarianStatus.ALLOWED,
  veganStatus: VeganStatus.VEGAN,
  animalLabels: [],
  allergenLabels: [],
  mayContainAllergens: [],
  compositionComplete: true,
  allergensComplete: true,
  safetyVersion: 1,
};
export const confirmedDietaryProfile = {
  dietMode: DietMode.VEGETARIAN,
  allergyAcknowledgement: AllergyAcknowledgement.NONE_DECLARED,
  dietaryVersion: 0,
  dietaryUpdatedAt: null,
};

export function mockDietaryReads(prisma: DeepMockProxy<PrismaService>) {
  prisma.userAvoidedIngredient.findMany.mockResolvedValue([]);
  prisma.userAvoidedGroup.findMany.mockResolvedValue([]);
  prisma.userAvoidedLabel.findMany.mockResolvedValue([]);
  prisma.userLikedIngredient.findMany.mockResolvedValue([]);
  prisma.ingredientGroup.findMany.mockResolvedValue([]);
  prisma.$transaction.mockImplementation((run: unknown) =>
    typeof run === 'function'
      ? (run as (tx: PrismaService) => Promise<unknown>)(prisma)
      : Promise.all(run as Promise<unknown>[]),
  );
}
