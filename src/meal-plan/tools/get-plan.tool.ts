import { tool } from 'ai';
import { z } from 'zod';
import { MEAL_SECTIONS } from '../dto/meal-plan.dto.js';
import type { MealPlanService } from '../meal-plan.service.js';
import { DAY_NAMES, SECTION_NAMES } from '../meal-planner.prompt.js';
import { describeDraft } from './proposal-text.js';

export function getPlanTool(mealPlan: MealPlanService, userId: string) {
  return tool({
    description:
      "Read the user's saved weekly plan and the unsaved draft built so far. Use it before editing when you need to know what is in a slot now, and after the user saved or dismissed something.",
    inputSchema: z.object({}),
    execute: async () => {
      const [plan, draft] = await Promise.all([
        mealPlan.find(userId),
        mealPlan.getDraft(userId),
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
        value: `Saved plan:\n${saved.join('\n')}\n\nUnsaved draft (changes from the saved plan):\n${draft === '' ? '(none)' : draft}`,
      };
    },
  });
}
