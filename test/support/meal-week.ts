import { runtimeConfig } from '@src/config/runtime-config.js';
import { addDays, calendarDate, mondayOf } from '@src/meal-plan/meal-week.js';

/**
 * Monday of next week in the app time zone. The whole week is in the future,
 * so no day is locked as already past, and it is inside the planning horizon.
 */
export function nextWeekStart(now = new Date()): string {
  return addDays(mondayOf(calendarDate(now, runtimeConfig.APP_TIMEZONE)), 7);
}
