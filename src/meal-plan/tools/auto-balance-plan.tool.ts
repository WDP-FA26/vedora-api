import { tool } from 'ai';
import { z } from 'zod';
import { Weekday } from '../../mongo/models.js';
import type { MealPlanService } from '../meal-plan.service.js';
import { DAY_NAMES } from '../meal-planner.prompt.js';
import {
  passedDays,
  plannableWeekStarts,
  weekStartInput,
} from './planner-weeks.js';
import { changeFeedback, type PlanChange } from './proposal-text.js';

export type AutoBalanceOutput = PlanChange & {
  filled: number;
  targetCalories: number;
  passedDays?: { day: Weekday; date: string }[];
};

function passedNote(output: AutoBalanceOutput): string {
  if (!output.passedDays || output.passedDays.length === 0) return '';
  const days = output.passedDays
    .map(({ day, date }) => `${DAY_NAMES[day]} ${date}`)
    .join(', ');
  return `\nDAY_PASSED: ${days} came before today, so they were skipped and cannot change. Tell the user plainly.`;
}

export function autoBalancePlanTool(
  mealPlan: MealPlanService,
  userId: string,
  openWeekStart: string,
) {
  return tool({
    description:
      "Automatically rebalance editable days of a week toward the calorie target while keeping existing main dishes: tops up under-calorie days with complementary 2nd/3rd dishes (e.g. main + stir-fry/soup + snack in OTHER) and trims excess secondary dishes on over-budget days. Saves the result to the user's plan at once (the user can rewind it from the chat). Do not use to fill an empty week (use fillSlots) or to swap one specific dish (use editPlan).",
    inputSchema: z.object({
      weekStart: weekStartInput(plannableWeekStarts()),
      days: z
        .array(z.enum(Weekday))
        .min(1)
        .max(7)
        .optional()
        .describe(
          'Optional subset of days to balance; defaults to all editable days',
        ),
      targetCalories: z
        .number()
        .int()
        .min(800)
        .max(4500)
        .optional()
        .describe(
          'Optional daily kcal budget override (e.g. after accounting for eating out)',
        ),
    }),
    execute: async ({
      weekStart,
      days,
      targetCalories,
    }): Promise<AutoBalanceOutput> => {
      const week = weekStart ?? openWeekStart;
      const result = await mealPlan.autoBalancePlan(userId, {
        weekStart: week,
        days,
        targetCalories,
      });
      const passed = days && days.length > 0 ? passedDays(week, days) : [];
      if (passed.length === 0) return result;
      return { ...result, passedDays: passed };
    },
    toModelOutput: ({ output }) => {
      const note = passedNote(output);
      if (!output.applied && output.problems.length === 0) {
        return {
          type: 'text',
          value: `The schedule already sits comfortably around ~${output.targetCalories} kcal/day, so no slot changed.${note}`,
        };
      }
      return {
        type: 'text',
        value: `Auto-balanced against ~${output.targetCalories} kcal/day.\n${changeFeedback(output)}${note}`,
      };
    },
  });
}
