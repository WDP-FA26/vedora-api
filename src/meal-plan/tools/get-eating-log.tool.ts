import { tool } from 'ai';
import { z } from 'zod';
import { CalorieSource } from '../../mongo/models.js';
import type { MealLogService } from '../meal-log/meal-log.service.js';
import { DAY_NAMES, SECTION_NAMES } from '../meal-planner.prompt.js';
import { plannableWeekStarts, weekStartInput } from './planner-weeks.js';

/**
 * What the user actually ate this week, beside the plan and their target. The
 * planner reads it before adjusting the days still ahead.
 */
export function getEatingLogTool(
  mealLog: MealLogService,
  userId: string,
  openWeekStart: string,
) {
  return tool({
    description:
      "Read what the user logged as eaten in one week (the food diary), with each day's planned calories and their daily target. Use it when the user asks how their week went or wants the coming days adjusted to what they really ate. Days after today have no log yet.",
    inputSchema: z.object({
      weekStart: weekStartInput(plannableWeekStarts()),
    }),
    execute: async (input) => {
      const weekStart = input.weekStart ?? openWeekStart;
      return { log: await mealLog.week(userId, weekStart) };
    },
    toModelOutput: ({ output }) => {
      const { log } = output;
      const lines: string[] = [];
      for (const day of log.days) {
        const planned =
          day.plannedCalories === null
            ? 'kế hoạch trống'
            : `kế hoạch ~${day.plannedCalories} kcal`;
        if (!day.loggable) {
          lines.push(
            `- ${DAY_NAMES[day.day]} (${day.date}): chưa tới; ${planned}`,
          );
          continue;
        }
        if (day.entries.length === 0) {
          lines.push(
            `- ${DAY_NAMES[day.day]} (${day.date}): chưa ghi gì; ${planned}`,
          );
          continue;
        }
        const dishes: string[] = [];
        for (const entry of day.entries) {
          const kcal =
            entry.calories === null
              ? 'chưa rõ kcal'
              : `~${entry.calories} kcal`;
          const estimate =
            entry.calorieSource === CalorieSource.WEB_ESTIMATE
              ? ', AI ước tính'
              : '';
          dishes.push(
            `${SECTION_NAMES[entry.section]}: ${entry.name} ×${entry.servings} (${kcal}${estimate}) [id: ${entry.id}]`,
          );
        }
        const unknown =
          day.unknownCalorieEntries > 0
            ? `, ${day.unknownCalorieEntries} món chưa rõ kcal`
            : '';
        lines.push(
          `- ${DAY_NAMES[day.day]} (${day.date}): đã ăn ~${day.loggedCalories} kcal${unknown}; ${planned}. ${dishes.join('; ')}`,
        );
      }
      const target =
        log.dailyCalorieTarget === null
          ? 'Người dùng chưa có mục tiêu kcal.'
          : `Mục tiêu ~${log.dailyCalorieTarget} kcal/ngày (vùng ${log.dailyCalorieMin}–${log.dailyCalorieMax}).`;
      const average =
        log.summary.averageCalories === null
          ? 'Chưa có ngày nào được ghi.'
          : `Trung bình ~${log.summary.averageCalories} kcal trên ${log.summary.loggedDays} ngày đã ghi.`;
      return {
        type: 'text',
        value: `Nhật ký tuần ${log.weekStart} (hôm nay ${log.today}). ${target} ${average} Còn ${log.summary.remainingDays} ngày có thể chỉnh.\n${lines.join('\n')}`,
      };
    },
  });
}
