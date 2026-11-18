import { z } from 'zod';
import { Weekday } from '../../mongo/models.js';
import {
  addDays,
  currentMealWeek,
  MEAL_PLAN_WEEKS_AHEAD,
} from '../meal-week.js';

/** The Mondays the planner may write to: this week and the weeks ahead, in order. */
export function plannableWeekStarts(
  now: Date = new Date(),
): [string, ...string[]] {
  const { currentWeekStart } = currentMealWeek(undefined, now);
  const weeks: [string, ...string[]] = [currentWeekStart];
  for (let ahead = 1; ahead <= MEAL_PLAN_WEEKS_AHEAD; ahead += 1) {
    weeks.push(addDays(currentWeekStart, ahead * 7));
  }
  return weeks;
}

/** The optional `weekStart` a planner tool takes; only the plannable weeks are accepted. */
export function weekStartInput(weeks: [string, ...string[]]) {
  return z
    .enum(weeks)
    .optional()
    .describe(
      'Monday (YYYY-MM-DD) of the week to work on, from the calendar in your instructions. Omit it for the week the user has open',
    );
}

/** The days in `days` that come before today in the week of `weekStart`. */
export function passedDays(
  weekStart: string,
  days: readonly Weekday[],
): { day: Weekday; date: string }[] {
  const week = currentMealWeek(weekStart);
  const passed: { day: Weekday; date: string }[] = [];
  for (const day of days) {
    if (week.editableDays.includes(day)) continue;
    passed.push({ day, date: week.dates[day] });
  }
  return passed;
}
