import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WEEKDAYS } from './dto/meal-plan.dto';
import {
  ShoppingListDto,
  ShoppingListItemDto,
  ShoppingListQueryDto,
} from './dto/shopping-list.dto';

const entrySelect = {
  day: true,
  section: true,
  recipe: {
    select: {
      id: true,
      title: true,
      servings: true,
      ingredients: {
        select: {
          ingredientId: true,
          quantity: true,
          unit: true,
          note: true,
          ingredient: { select: { name: true } },
        },
        orderBy: { position: 'asc' },
      },
    },
  },
} satisfies Prisma.MealPlanEntrySelect;

@Injectable()
export class ShoppingListService {
  constructor(private readonly prisma: PrismaService) {}

  async get(
    userId: string,
    query: ShoppingListQueryDto,
  ): Promise<ShoppingListDto> {
    const days = WEEKDAYS.filter((day) => query.days.includes(day));
    return this.prisma.$transaction(
      async (tx) => {
        // Prisma may load related recipes/ingredients in separate SQL statements.
        // Keep them in one snapshot if the timetable or a recipe changes mid-read.
        const entries = await tx.mealPlanEntry.findMany({
          where: { userId, day: { in: days } },
          select: entrySelect,
          orderBy: [
            { day: 'asc' },
            { section: 'asc' },
            { position: 'asc' },
            { recipeId: 'asc' },
          ],
        });
        const groups = new Map<
          string,
          { item: ShoppingListItemDto; sum: Prisma.Decimal; knownCount: number }
        >();
        for (const { day, section, recipe } of entries) {
          for (const source of recipe.ingredients) {
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
                sum: new Prisma.Decimal(0),
                knownCount: 0,
              };
              groups.set(key, group);
            }
            if (source.quantity === null) group.item.hasUnknownQuantity = true;
            else {
              group.sum = group.sum.plus(source.quantity);
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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
