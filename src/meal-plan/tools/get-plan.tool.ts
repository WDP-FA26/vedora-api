import { tool } from 'ai';
import { z } from 'zod';
import { MEAL_SECTIONS } from '../dto/meal-plan.dto.js';
import type { MealPlanService } from '../meal-plan.service.js';
import { DAY_NAMES, SECTION_NAMES } from '../meal-planner.prompt.js';
import { planOutput } from './output-schemas.js';
import { plannableWeekStarts, weekStartInput } from './planner-weeks.js';

export function getPlanTool(
  mealPlan: MealPlanService,
  userId: string,
  openWeekStart: string,
) {
  return tool({
    description:
      "Read the user's plan of one week. Use it before editing when you need to know what is in a slot now (the user may also have changed the calendar or rewound your changes). Pass weekStart for a week other than the one the user has open.",
    inputSchema: z.object({
      weekStart: weekStartInput(plannableWeekStarts()),
    }),
    outputSchema: planOutput,
    execute: async (input) => {
      const weekStart = input.weekStart ?? openWeekStart;
      const plan = await mealPlan.find(userId, weekStart);
      return { plan };
    },
    toModelOutput: ({ output }) => {
      const saved: string[] = [];
      for (const { day, sections } of output.plan.days) {
        const filled: string[] = [];
        let dayCalories = 0;
        let hasCalories = false;
        for (const section of MEAL_SECTIONS) {
          const recipes =
            sections.find((item) => item.section === section)?.recipes ?? [];
          if (recipes.length === 0) continue;
          for (const recipe of recipes) {
            if (typeof recipe.caloriesPerServing === 'number') {
              dayCalories += recipe.caloriesPerServing;
              hasCalories = true;
            }
          }
          const names = recipes
            .map(({ title, id, caloriesPerServing }) =>
              typeof caloriesPerServing === 'number'
                ? `${title} (id ${id}, ~${caloriesPerServing} kcal)`
                : `${title} (id ${id})`,
            )
            .join(', ');
          filled.push(`${SECTION_NAMES[section]}: ${names}`);
        }
        const totalNote = hasCalories ? ` [~${dayCalories} kcal]` : '';
        saved.push(
          `- ${DAY_NAMES[day]}: ${filled.length > 0 ? filled.join('; ') : '(empty)'}${totalNote}`,
        );
      }
      return {
        type: 'text',
        value: `Week of ${output.plan.weekStart}. Plan:\n${saved.join('\n')}`,
      };
    },
  });
}
