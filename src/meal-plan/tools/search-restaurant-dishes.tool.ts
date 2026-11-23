import { tool } from 'ai';
import { z } from 'zod';
import { MAX_GENERATE_QUERY_LENGTH } from '../dto/meal-plan.dto.js';
import type {
  PlannerRestaurantDishSuggestion,
  RestaurantMenuService,
} from '../../workspaces/restaurant-menu.service.js';

export function searchRestaurantDishesTool(
  restaurantMenu: RestaurantMenuService,
  avoidedTerms: readonly string[],
) {
  return tool({
    description:
      'Search vegetarian dishes served by approved restaurants on Vedora. Use it only when the user says they want to eat out, asks about restaurants or ready-made food, or asks for restaurant dishes. Do not use it to find a replacement when the user changes a dish on their plan: restaurant dishes cannot be placed on the plan (use searchRecipes for that). Every dish returned is shown to the user as a card in the chat, so only search for what you will recommend. Returns dish details, price in VND, restaurant name, address, star rating, and any AVOIDED ingredient warning.',
    inputSchema: z.object({
      query: z
        .string()
        .max(MAX_GENERATE_QUERY_LENGTH)
        .optional()
        .describe(
          'Vietnamese dish keyword, ingredient, or restaurant name/address, e.g. "bún chay", "lẩu nấm"',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(15)
        .optional()
        .describe('Maximum number of restaurant dishes to return (default 8)'),
    }),
    execute: ({ query, limit }) =>
      restaurantMenu.suggestForPlanner(query, limit ?? 8, avoidedTerms),
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: formatLines(output),
    }),
  });
}

function formatPrice(priceVnd: number | null): string {
  if (priceVnd === null) return 'giá liên hệ';
  return `${priceVnd.toLocaleString('vi-VN')} ₫`;
}

function formatRating(
  averageRating: number | null,
  reviewCount: number,
): string {
  if (averageRating === null || reviewCount === 0) return 'chưa có đánh giá';
  return `${averageRating}★ (${reviewCount} đánh giá)`;
}

function formatLines(dishes: PlannerRestaurantDishSuggestion[]): string {
  if (dishes.length === 0) return 'No restaurant dishes found.';
  return dishes
    .map((dish) => {
      const parts = [
        dish.id,
        dish.name,
        dish.category ?? 'món nhà hàng',
        formatPrice(dish.priceVnd),
        `nhà hàng: ${dish.restaurant.name} (@${dish.restaurant.username})`,
        `địa chỉ: ${dish.restaurant.address}`,
        formatRating(
          dish.restaurant.averageRating,
          dish.restaurant.reviewCount,
        ),
      ];
      if (dish.description?.trim()) parts.push(dish.description.trim());
      if (dish.avoidedMatches.length > 0) {
        parts.push(`AVOIDED: ${dish.avoidedMatches.join(', ')}`);
      }
      return parts.join(' | ');
    })
    .join('\n');
}
