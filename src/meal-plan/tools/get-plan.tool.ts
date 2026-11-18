import { tool } from 'ai';
import { z } from 'zod';
import { MEAL_SECTIONS } from '../dto/meal-plan.dto.js';
import type { MealPlanService } from '../meal-plan.service.js';
import { DAY_NAMES, SECTION_NAMES } from '../meal-planner.prompt.js';
import { plannableWeekStarts, weekStartInput } from './planner-weeks.js';
import { describeDraft } from './proposal-text.js';

export function getPlanTool(
  mealPlan: MealPlanService,
  userId: string,
  openWeekStart: string,
) {
  return tool({
    description:
      "Read the user's saved plan of one week and the unsaved draft built so far for it. Use it before editing when you need to know what is in a slot now, and after the user saved or dismissed something. Pass weekStart for a week other than the one the user has open.",
    inputSchema: z.object({
      weekStart: weekStartInput(plannableWeekStarts()),
    }),
    execute: async (input) => {
      const weekStart = input.weekStart ?? openWeekStart;
      const [plan, draft] = await Promise.all([
        mealPlan.find(userId, weekStart),
        mealPlan.getDraft(userId, weekStart),
      ]);
      return { plan, draft };
    },
    toModelOutput: ({ output }) => {
      const saved: string[] = [];
      for (const { day, sections } of output.plan.days) {
        const filled: string[] = [];
        for (const section of MEAL_SECTIONS) {
          const recipes =
            sections.find((item) => item.section === section)?.recipes ?? [];
          if (recipes.length === 0) continue;
          const names = recipes
            .map(({ title, id }) => `${title} (id ${id})`)
            .join(', ');
          filled.push(`${SECTION_NAMES[section]}: ${names}`);
        }
        saved.push(
          `- ${DAY_NAMES[day]}: ${filled.length > 0 ? filled.join('; ') : '(empty)'}`,
        );
      }
      const draft = describeDraft(output.draft);
      return {
        type: 'text',
        value: `Week of ${output.plan.weekStart}. Saved plan:\n${saved.join('\n')}\n\nUnsaved draft (changes from the saved plan):\n${draft === '' ? '(none)' : draft}`,
      };
    },
  });
}
