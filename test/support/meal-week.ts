import { runtimeConfig } from '@src/config/runtime-config.js';
import { addDays, calendarDate, mondayOf } from '@src/meal-plan/meal-week.js';

export function nextWeekStart(now = new Date()): string {
  return addDays(mondayOf(calendarDate(now, runtimeConfig.APP_TIMEZONE)), 7);
}
