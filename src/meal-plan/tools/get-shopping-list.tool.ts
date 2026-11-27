import { tool } from 'ai';
import { z } from 'zod';
import { Weekday } from '../../mongo/models.js';
import { WEEKDAYS } from '../dto/meal-plan.dto.js';
import type { ShoppingListDto } from '../dto/shopping-list.dto.js';
import { DAY_NAMES } from '../meal-planner.prompt.js';
import type { ShoppingListService } from '../shopping-list.service.js';
import {
  passedDays,
  plannableWeekStarts,
  weekStartInput,
} from './planner-weeks.js';

const MAX_PEOPLE = 20;

export function shoppingLines(list: ShoppingListDto, people: number): string[] {
  return list.items.map((item) => {
    let sum = 0;
    let knownCount = 0;
    let hasUnknown = item.hasUnknownQuantity;
    const dishTitles = new Set<string>();
    for (const contribution of item.contributions) {
      dishTitles.add(contribution.recipeTitle);
      if (contribution.quantity === null) {
        hasUnknown = true;
        continue;
      }
      const servings = contribution.servings > 0 ? contribution.servings : 1;
      sum += (Number(contribution.quantity) / servings) * people;
      knownCount += 1;
    }
    let amount = 'chưa rõ lượng';
    if (knownCount > 0) {
      const rounded = Math.round(sum * 100) / 100;
      amount = [rounded, item.unit].filter(Boolean).join(' ');
      if (hasUnknown) amount += ' + phần chưa rõ lượng';
    }
    return `${item.name} (${amount}; món: ${[...dishTitles].join(', ')})`;
  });
}

export function getShoppingListTool(
  shoppingList: ShoppingListService,
  userId: string,
  openWeekStart: string,
) {
  return tool({
    description:
      "Read the shopping list of one week's plan: every ingredient of the planned dishes, already added up and scaled to the number of eaters, with the dishes that use it. Use it whenever the user asks what or how much to buy for planned meals, rather than adding up recipes yourself. It covers today and later days only.",
    inputSchema: z.object({
      weekStart: weekStartInput(plannableWeekStarts()),
      days: z
        .array(z.enum(Weekday))
        .min(1)
        .max(7)
        .optional()
        .describe('Days to shop for; omit for the whole week'),
      people: z
        .number()
        .int()
        .min(1)
        .max(MAX_PEOPLE)
        .optional()
        .describe('Number of eaters to scale quantities to; defaults to 1'),
    }),
    execute: async ({ weekStart, days, people }) => {
      const week = weekStart ?? openWeekStart;
      const eaters = people ?? 1;
      const list = await shoppingList.get(userId, {
        weekStart: week,
        days: days ?? [...WEEKDAYS],
      });
      return {
        weekStart: week,
        days: list.days,
        passedDays: days ? passedDays(week, days) : [],
        people: eaters,
        items: shoppingLines(list, eaters),
      };
    },
    toModelOutput: ({ output }) => {
      const days = output.days.map((day) => DAY_NAMES[day]).join(', ');
      const lines = [
        `Danh sách đi chợ tuần bắt đầu ${output.weekStart} (${days || 'không còn ngày nào từ hôm nay'}) cho ${output.people} người ăn.`,
      ];
      if (output.passedDays.length > 0) {
        const passed = output.passedDays
          .map(({ day, date }) => `${DAY_NAMES[day]} ${date}`)
          .join(', ');
        lines.push(`Không tính các ngày đã qua: ${passed}.`);
      }
      if (output.items.length === 0) {
        lines.push('Không có nguyên liệu nào cần mua trong phạm vi này.');
      } else {
        lines.push(`${output.items.length} nguyên liệu:`);
        for (const item of output.items) lines.push(`- ${item}`);
      }
      return { type: 'text', value: lines.join('\n') };
    },
  });
}
