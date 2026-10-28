import type { Model } from 'mongoose';
import { Ingredient, Recipe, RecipeIngredient } from '../mongo/models';
import { escapeRegExp } from '../common/text';
import type { RecipeCatalogQueryDto } from './dto/recipe-catalog.dto';
import type { DietaryService } from './dietary.service';
import type { IncompatibilityRulesService } from './incompatibility-rules.service';

export interface CatalogPage {
  ids: string[];
  total: number;
}

interface CatalogDeps {
  recipes: Model<Recipe>;
  recipeIngredients: Model<RecipeIngredient>;
  ingredients: Model<Ingredient>;
  dietary: DietaryService;
  rules: IncompatibilityRulesService;
}

/**
 * The recipes of one catalog page, newest first, and how many match in all.
 * MongoDB has no relation filters, and total minutes and conflicts inside a
 * recipe are no filter at all, so this reads the ids, times and ingredients
 * of every recipe the title/description filter leaves and filters them
 * here. The catalog is admin-curated and small.
 */
export async function catalogPage(
  { recipes, recipeIngredients, ingredients, dietary, rules }: CatalogDeps,
  query: RecipeCatalogQueryDto,
  paging: { skip: number; take: number },
  userId?: string,
): Promise<CatalogPage> {
  const [rows, links] = await Promise.all([
    recipes
      .find()
      .select('title description prepMinutes cookMinutes')
      .sort({ updatedAt: -1, _id: -1 })
      .exec(),
    recipeIngredients.find().select('recipeId ingredientId').exec(),
  ]);
  const ingredientsOf = (recipeId: string) =>
    links
      .filter((link) => link.recipeId === recipeId)
      .map(({ ingredientId }) => ingredientId);

  let matching = rows;
  if (query.q !== undefined) {
    const matchingIds = await matchingRecipes(
      recipes,
      recipeIngredients,
      ingredients,
      query.q,
    );
    matching = matching.filter(({ id }) => matchingIds.has(id));
  }
  if (query.maxMinutes !== undefined) {
    const max = query.maxMinutes;
    // A recipe with both times unknown never matches.
    matching = matching.filter(
      ({ prepMinutes, cookMinutes }) =>
        (prepMinutes !== null || cookMinutes !== null) &&
        (prepMinutes ?? 0) + (cookMinutes ?? 0) <= max,
    );
  }
  if (query.suitableForMe && userId) {
    const avoided = await dietary.avoidedIngredientIds(userId);
    matching = matching.filter(({ id }) =>
      ingredientsOf(id).every((ingredientId) => !avoided.has(ingredientId)),
    );
    const conflicts = await rules.findConflictsForEach(
      matching.map(({ id }) => ingredientsOf(id)),
    );
    matching = matching.filter((_, index) => conflicts[index].length === 0);
  }
  return {
    ids: matching
      .slice(paging.skip, paging.skip + paging.take)
      .map(({ id }) => id),
    total: matching.length,
  };
}

/** Title, description, or an ingredient whose name or alias contains `text`. */
async function matchingRecipes(
  recipes: Model<Recipe>,
  recipeIngredients: Model<RecipeIngredient>,
  ingredients: Model<Ingredient>,
  text: string,
): Promise<Set<string>> {
  const pattern = escapeRegExp(text);
  const [byText, matchingIngredients] = await Promise.all([
    recipes
      .find({
        $or: [
          { title: { $regex: pattern, $options: 'i' } },
          { description: { $regex: pattern, $options: 'i' } },
        ],
      })
      .select('_id')
      .exec(),
    ingredients
      .find({
        $or: [
          { name: { $regex: pattern, $options: 'i' } },
          { aliases: { $regex: pattern, $options: 'i' } },
        ],
      })
      .select('_id')
      .exec(),
  ]);
  const byIngredient = await recipeIngredients
    .find({
      ingredientId: { $in: matchingIngredients.map(({ id }) => id) },
    })
    .select('recipeId')
    .exec();
  return new Set([
    ...byText.map(({ id }) => id),
    ...byIngredient.map(({ recipeId }) => recipeId),
  ]);
}
