import {
  AllergyAcknowledgement,
  AnimalLabel,
  DietMode,
  Prisma,
  VeganStatus,
  VegetarianStatus,
} from '@prisma/client';

/** Reused by SQL catalog queries and in-memory meal checks. */
export const ingredientSafetySelect = {
  name: true,
  active: true,
  vegetarianStatus: true,
  veganStatus: true,
  animalLabels: true,
  allergenLabels: true,
  mayContainAllergens: true,
  compositionComplete: true,
  allergensComplete: true,
  safetyVersion: true,
} satisfies Prisma.IngredientSelect;

export type IngredientSafety = Prisma.IngredientGetPayload<{
  select: typeof ingredientSafetySelect;
}>;
export type DietarySafetyContext = {
  dietMode: DietMode;
  allergyAcknowledgement: AllergyAcknowledgement;
  hasAllergy: boolean;
  avoidedIds: Set<string>;
  animalLabels: string[];
  allergenLabels: string[];
};

export function ingredientProblem(
  id: string,
  ingredient: IngredientSafety,
  context: DietarySafetyContext,
):
  | 'AVOIDED_INGREDIENT'
  | 'UNVERIFIED_INGREDIENT'
  | 'ALLERGEN_INFORMATION_INCOMPLETE'
  | null {
  if (
    context.avoidedIds.has(id) ||
    ingredient.animalLabels.some((label) =>
      context.animalLabels.includes(label),
    ) ||
    [...ingredient.allergenLabels, ...ingredient.mayContainAllergens].some(
      (label) => context.allergenLabels.includes(label),
    )
  )
    return 'AVOIDED_INGREDIENT';
  if (
    !ingredient.active ||
    ingredient.vegetarianStatus !== VegetarianStatus.ALLOWED ||
    !ingredient.compositionComplete ||
    (context.dietMode === DietMode.VEGAN &&
      (ingredient.veganStatus !== VeganStatus.VEGAN ||
        ingredient.animalLabels.length > 0))
  )
    return 'UNVERIFIED_INGREDIENT';
  if (context.hasAllergy && !ingredient.allergensComplete)
    return 'ALLERGEN_INFORMATION_INCOMPLETE';
  return null;
}

/** Public recipes must contain actual, verified Vegetarian ingredients. */
export function publicRecipePredicate(): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.recipe_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM recipe_ingredients ri JOIN ingredients i ON i.id = ri.ingredient_id
      WHERE ri.recipe_id = r.id AND i.vegetarian_status <> 'ALLOWED')`;
}

export function veganRecipePredicate(): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (SELECT 1 FROM recipe_ingredients ri JOIN ingredients i ON i.id = ri.ingredient_id
    WHERE ri.recipe_id = r.id AND (i.vegan_status <> 'VEGAN' OR cardinality(i.animal_labels) > 0))`;
}

/** Every personal exclusion, including labels and MAY_CONTAIN, runs before paging. */
export function suitableRecipePredicate(userId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${userId}::uuid
    AND u.allergy_acknowledgement <> 'UNCONFIRMED'
    AND (u.diet_mode <> 'VEGAN' OR ${veganRecipePredicate()}))
    AND NOT EXISTS (
      SELECT 1 FROM recipe_ingredients ri JOIN ingredients i ON i.id = ri.ingredient_id
      WHERE ri.recipe_id = r.id AND (
        NOT i.active OR NOT i.composition_complete
        OR EXISTS (SELECT 1 FROM user_avoided_ingredients a WHERE a.user_id = ${userId}::uuid AND a.ingredient_id = i.id)
        OR EXISTS (SELECT 1 FROM ingredient_group_members m JOIN user_avoided_groups a ON a.group_id = m.group_id WHERE a.user_id = ${userId}::uuid AND m.ingredient_id = i.id)
        OR EXISTS (SELECT 1 FROM user_avoided_labels a WHERE a.user_id = ${userId}::uuid AND (
          (a.kind = 'ANIMAL' AND a.label = ANY(i.animal_labels::text[]))
          OR (a.kind = 'ALLERGEN' AND (a.label = ANY(i.allergen_labels::text[]) OR a.label = ANY(i.may_contain_allergens::text[])))))
        OR (NOT i.allergens_complete AND (
          EXISTS (SELECT 1 FROM user_avoided_ingredients a WHERE a.user_id = ${userId}::uuid AND a.reason = 'ALLERGY')
          OR EXISTS (SELECT 1 FROM user_avoided_groups a WHERE a.user_id = ${userId}::uuid AND a.reason = 'ALLERGY')
          OR EXISTS (SELECT 1 FROM user_avoided_labels a WHERE a.user_id = ${userId}::uuid AND a.reason = 'ALLERGY')))
      ))`;
}

export const VEGAN_ANIMAL_LABELS = Object.values(AnimalLabel);
