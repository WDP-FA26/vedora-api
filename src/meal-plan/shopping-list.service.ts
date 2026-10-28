import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  Ingredient,
  MealPlanEntry,
  Recipe,
  type Weekday,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { MEAL_SECTIONS, WEEKDAYS } from './dto/meal-plan.dto.js';
import {
  ShoppingListDto,
  ShoppingListItemDto,
  ShoppingListQueryDto,
} from './dto/shopping-list.dto.js';

@Injectable()
export class ShoppingListService {
  constructor(
    @InjectModel(MealPlanEntry.name)
    private readonly entries: Model<MealPlanEntry>,
    @InjectModel(Recipe.name)
    private readonly recipes: Model<Recipe>,
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
    private readonly mongo: MongoService,
  ) {}

  async get(
    userId: string,
    query: ShoppingListQueryDto,
  ): Promise<ShoppingListDto> {
    const days = WEEKDAYS.filter((day) => query.days.includes(day));
    const { loaded, ingredientById } = await this.load(userId, days);
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
      for (const source of recipe.ingredients) {
        const ingredient = ingredientById.get(source.ingredientId);
        if (!ingredient) continue;
        // Empty/whitespace legacy units mean unspecified. Do not case-fold or
        // convert units: g, kg, ml and individual pieces stay separate.
        const unit = source.unit?.trim() || null;
        const key = JSON.stringify([source.ingredientId, unit]);
        let group = groups.get(key);
        if (!group) {
          group = {
            item: {
              ingredientId: source.ingredientId,
              name: ingredient.name,
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
          recipeId: recipe.id,
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
   * The timetable entries of `days` with their recipes and ingredient names.
   * Read in one transaction, so a timetable or recipe changed mid-read can't
   * mix old and new data.
   */
  private load(userId: string, days: Weekday[]) {
    return this.mongo.withTransaction(async (session) => {
      const entries = await this.entries
        .find({ userId, day: { $in: days } })
        .sort({ position: 1, recipeId: 1 })
        .session(session)
        .exec();
      const recipeIds = [...new Set(entries.map(({ recipeId }) => recipeId))];
      const recipes = await this.recipes
        .find({ _id: { $in: recipeIds } })
        .session(session)
        .exec();
      const names = await this.ingredients
        .find({
          _id: {
            $in: [
              ...new Set(
                recipes.flatMap((recipe) =>
                  recipe.ingredients.map(({ ingredientId }) => ingredientId),
                ),
              ),
            ],
          },
        })
        .session(session)
        .exec();
      const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
      const ingredientById = new Map(names.map((item) => [item.id, item]));
      return {
        loaded: entries.flatMap((entry) => {
          const recipe = recipeById.get(entry.recipeId);
          return recipe
            ? [{ day: entry.day, section: entry.section, recipe }]
            : [];
        }),
        ingredientById,
      };
    });
  }
}
