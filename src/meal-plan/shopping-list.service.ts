import { Injectable } from '@nestjs/common';
import type {
  Ingredient,
  MealPlanEntry,
  Recipe,
  RecipeIngredient,
  Stored,
  Weekday,
} from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';
import { MEAL_SECTIONS, WEEKDAYS } from './dto/meal-plan.dto';
import {
  ShoppingListDto,
  ShoppingListItemDto,
  ShoppingListQueryDto,
} from './dto/shopping-list.dto';

@Injectable()
export class ShoppingListService {
  constructor(private readonly mongo: MongoService) {}

  async get(
    userId: string,
    query: ShoppingListQueryDto,
  ): Promise<ShoppingListDto> {
    const days = WEEKDAYS.filter((day) => query.days.includes(day));
    const { loaded, ingredients } = await this.load(userId, days);
    // Enums are plain strings in MongoDB and sort alphabetically, so the
    // day and section order (Mon..Sun, breakfast..other) is applied here.
    // The sort is stable: position and recipe order carry over within one.
    const entries = loaded.sort(
      (a, b) =>
        WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day) ||
        MEAL_SECTIONS.indexOf(a.section) - MEAL_SECTIONS.indexOf(b.section),
    );
    const groups = new Map<
      string,
      { item: ShoppingListItemDto; sum: number; knownCount: number }
    >();
    for (const { day, section, recipe } of entries) {
      const sources = ingredients.filter(
        (item) => item.recipeId === recipe._id,
      );
      for (const source of sources) {
        // Empty/whitespace legacy units mean unspecified. Do not case-fold or
        // convert units: g, kg, ml and individual pieces stay separate.
        const unit = source.unit?.trim() || null;
        const key = JSON.stringify([source.ingredientId, unit]);
        let group = groups.get(key);
        if (!group) {
          group = {
            item: {
              ingredientId: source.ingredientId,
              name: source.ingredient.name,
              unit,
              knownQuantity: null,
              hasUnknownQuantity: false,
              contributions: [],
            },
            sum: 0,
            knownCount: 0,
          };
          groups.set(key, group);
        }
        if (source.quantity === null) group.item.hasUnknownQuantity = true;
        else {
          group.sum += source.quantity;
          group.knownCount++;
        }
        group.item.contributions.push({
          recipeId: recipe._id,
          recipeTitle: recipe.title,
          day,
          section,
          servings: recipe.servings,
          quantity: source.quantity?.toFixed(2) ?? null,
          note: source.note,
        });
      }
    }
    const items = [...groups.values()]
      .map(({ item, sum, knownCount }) => ({
        ...item,
        knownQuantity: knownCount ? sum.toFixed(2) : null,
      }))
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name, 'vi') ||
          a.ingredientId.localeCompare(b.ingredientId) ||
          (a.unit ?? '').localeCompare(b.unit ?? ''),
      );
    return { days, quantityBasis: 'RECIPE_PER_OCCURRENCE', items };
  }

  /**
   * The timetable entries of `days` with their recipes, and those recipes'
   * ingredients with names. Read in one transaction, so a timetable or recipe
   * changed mid-read can't mix old and new data.
   */
  private load(userId: string, days: Weekday[]) {
    const { db: database } = this.mongo;
    return this.mongo.withTransaction(async (session) => {
      const entries = await database
        .collection<Stored<MealPlanEntry>>('meal_plan_entries')
        .find({ userId, day: { $in: days } }, { session })
        .sort({ position: 1, recipeId: 1 })
        .toArray();
      const recipeIds = [...new Set(entries.map(({ recipeId }) => recipeId))];
      const recipes = await database
        .collection<Stored<Recipe>>('recipes')
        .find({ _id: { $in: recipeIds } }, { session })
        .toArray();
      const items = await database
        .collection<Stored<RecipeIngredient>>('recipe_ingredients')
        .find({ recipeId: { $in: recipeIds } }, { session })
        .sort({ position: 1 })
        .toArray();
      const names = await database
        .collection<Stored<Ingredient>>('ingredients')
        .find(
          {
            _id: { $in: [...new Set(items.map((item) => item.ingredientId))] },
          },
          { session },
        )
        .toArray();
      const recipeById = new Map(recipes.map((recipe) => [recipe._id, recipe]));
      const ingredientById = new Map(names.map((item) => [item._id, item]));
      return {
        loaded: entries.flatMap((entry) => {
          const recipe = recipeById.get(entry.recipeId);
          return recipe ? [{ ...entry, recipe }] : [];
        }),
        ingredients: items.flatMap((item) => {
          const ingredient = ingredientById.get(item.ingredientId);
          return ingredient ? [{ ...item, ingredient }] : [];
        }),
      };
    });
  }
}
