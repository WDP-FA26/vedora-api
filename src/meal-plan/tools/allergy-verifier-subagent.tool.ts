import { tool } from 'ai';
import { z } from 'zod';
import { MealSection, Weekday } from '../../mongo/models.js';
import { MEAL_SECTIONS } from '../dto/meal-plan.dto.js';
import type { DraftOp } from '../meal-plan-draft.js';
import type { MealPlanService } from '../meal-plan.service.js';
import { DAY_NAMES, SECTION_NAMES } from '../meal-planner.prompt.js';
import { plannableWeekStarts, weekStartInput } from './planner-weeks.js';
import {
  changeFeedback,
  mergeChanges,
  type PlanChange,
} from './proposal-text.js';

export interface FlaggedDishReport {
  day: Weekday;
  section: MealSection;
  recipeId: string;
  title: string;
  reason: string;
}

export interface AllergyVerificationResult {
  verified: boolean;
  safe: boolean;
  checkedDishesCount: number;
  flaggedDishes: FlaggedDishReport[];
  uncheckedDishes: string[];
  summary: string;
  weekStart?: string;
  days?: PlanChange['days'];
  problems?: PlanChange['problems'];
  applied?: boolean;
}

type Plan = Awaited<ReturnType<MealPlanService['find']>>;

function editableSlots(
  plan: Plan,
): { day: Weekday; section: MealSection; recipeIds: string[] }[] {
  const result: { day: Weekday; section: MealSection; recipeIds: string[] }[] =
    [];
  for (const dayObj of plan.days) {
    if (!dayObj.editable) continue;
    for (const section of MEAL_SECTIONS) {
      const recipes =
        dayObj.sections.find((s) => s.section === section)?.recipes ?? [];
      result.push({
        day: dayObj.day,
        section,
        recipeIds: recipes.map((r) => r.id),
      });
    }
  }
  return result;
}

function titlesOf(plan: Plan): Map<string, string> {
  const titles = new Map<string, string>();
  for (const day of plan.days) {
    for (const section of day.sections) {
      for (const recipe of section.recipes) titles.set(recipe.id, recipe.title);
    }
  }
  return titles;
}

function verificationSummary(
  checked: number,
  flagged: FlaggedDishReport[],
  unchecked: string[],
  replaced: boolean,
): string {
  const parts: string[] = [];
  if (flagged.length === 0) {
    parts.push(
      `Đã kiểm tra ${checked} món theo hồ sơ dị ứng: không món nào vi phạm.`,
    );
  } else {
    const byRecipe = new Map<
      string,
      { title: string; reason: string; slots: string[] }
    >();
    for (const dish of flagged) {
      const slot = `${DAY_NAMES[dish.day]} ${SECTION_NAMES[dish.section]}`;
      const entry = byRecipe.get(dish.recipeId);
      if (entry) {
        entry.slots.push(slot);
        continue;
      }
      byRecipe.set(dish.recipeId, {
        title: dish.title,
        reason: dish.reason,
        slots: [slot],
      });
    }
    const lines: string[] = [];
    for (const { title, reason, slots } of byRecipe.values()) {
      lines.push(`- ${title} (${slots.join(', ')}): ${reason}`);
    }
    parts.push(
      `Đã kiểm tra ${checked} món, ${byRecipe.size} món không hợp hồ sơ dị ứng:\n${lines.join('\n')}`,
    );
    parts.push(
      replaced ? 'Đã đổi các món này sang món an toàn.' : 'Chưa đổi món nào.',
    );
  }
  if (unchecked.length > 0) {
    parts.push(
      `Chưa kiểm tra được ${unchecked.join(', ')}; giữ nguyên trên lịch, người dùng nên tự xem lại.`,
    );
  }
  return parts.join('\n');
}

export function verifyMealPlanAllergiesTool(
  mealPlan: MealPlanService,
  userId: string,
  openWeekStart: string,
) {
  return tool({
    description:
      'Run the Allergy Verification Subagent on the week’s plan to inspect every dish’s full ingredient list and cooking steps against the user’s saved allergy profile. Use it after you build or change a plan when the user has an allergy note or mentioned an allergy; save a newly mentioned allergy with updateMemory first. Replaces any flagged allergen dish with a safe alternative in the saved plan (the user can rewind it from the chat); set replaceFlagged: false to only report when the user asked for a check, not a change.',
    inputSchema: z.object({
      weekStart: weekStartInput(plannableWeekStarts()),
      replaceFlagged: z
        .boolean()
        .optional()
        .describe(
          'Automatically replace any flagged dish with a safe alternative (default true)',
        ),
    }),
    execute: async ({
      weekStart,
      replaceFlagged,
    }): Promise<AllergyVerificationResult> => {
      const week = weekStart ?? openWeekStart;
      const plan = await mealPlan.find(userId, week);
      const slots = editableSlots(plan);
      const uniqueIds = [...new Set(slots.flatMap((slot) => slot.recipeIds))];
      if (uniqueIds.length === 0) {
        return {
          verified: true,
          safe: true,
          checkedDishesCount: 0,
          flaggedDishes: [],
          uncheckedDishes: [],
          summary: `Tuần bắt đầu ${week} chưa có món nào trên lịch để kiểm định dị ứng.`,
        };
      }

      const allergy = await mealPlan.allergyCheck(userId, uniqueIds);
      const titles = titlesOf(plan);
      const uncheckedDishes = uniqueIds
        .filter((id) => allergy.unchecked.has(id))
        .map((id) => titles.get(id) ?? id);
      const flaggedDishes: FlaggedDishReport[] = [];
      for (const slot of slots) {
        for (const recipeId of slot.recipeIds) {
          const reason = allergy.unsafe.get(recipeId);
          if (reason === undefined) continue;
          flaggedDishes.push({
            day: slot.day,
            section: slot.section,
            recipeId,
            title: titles.get(recipeId) ?? recipeId,
            reason,
          });
        }
      }

      if (flaggedDishes.length === 0) {
        return {
          verified: true,
          safe: uncheckedDishes.length === 0,
          checkedDishesCount: uniqueIds.length,
          flaggedDishes: [],
          uncheckedDishes,
          summary: verificationSummary(
            uniqueIds.length,
            [],
            uncheckedDishes,
            false,
          ),
        };
      }

      let change: PlanChange | undefined;
      if (replaceFlagged !== false) {
        const removeOps: DraftOp[] = flaggedDishes.map((item) => ({
          op: 'remove',
          day: item.day,
          section: item.section,
          recipeId: item.recipeId,
        }));
        change = await mealPlan.editPlan(userId, week, removeOps);

        const affectedKeys = new Set<string>();
        const affectedDays = new Set<Weekday>();
        const affectedSections = new Set<MealSection>();
        for (const dish of flaggedDishes) {
          affectedKeys.add(`${dish.day}:${dish.section}`);
          affectedDays.add(dish.day);
          affectedSections.add(dish.section);
        }
        const pinned = [...affectedDays].flatMap((day) =>
          [...affectedSections]
            .filter((section) => !affectedKeys.has(`${day}:${section}`))
            .map((section) => ({ day, section })),
        );
        const refill = await mealPlan.fillPlan(userId, {
          weekStart: week,
          days: [...affectedDays],
          sections: [...affectedSections],
          onlyEmpty: true,
          avoidIds: [...allergy.unsafe.keys()],
          pinned,
        });
        change = mergeChanges(change, refill);
      }

      const replaced = change !== undefined && change.applied;
      return {
        verified: true,
        safe: replaced && uncheckedDishes.length === 0,
        checkedDishesCount: uniqueIds.length,
        flaggedDishes,
        uncheckedDishes,
        summary: verificationSummary(
          uniqueIds.length,
          flaggedDishes,
          uncheckedDishes,
          replaced,
        ),
        ...(change
          ? {
              weekStart: change.weekStart,
              days: change.days,
              problems: change.problems,
              applied: change.applied,
            }
          : {}),
      };
    },
    toModelOutput: ({ output }) => {
      const changeNote = formatChangeNote(output);
      return {
        type: 'text',
        value: `${output.summary}${changeNote}`,
      };
    },
  });
}

function formatChangeNote(output: AllergyVerificationResult): string {
  if (!output.days || !output.weekStart) return '';
  return `\n${changeFeedback({
    weekStart: output.weekStart,
    days: output.days,
    problems: output.problems ?? [],
    applied: output.applied ?? false,
  })}`;
}
