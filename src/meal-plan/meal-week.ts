import { runtimeConfig } from '../config/runtime-config.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { Weekday } from '../mongo/models.js';

/** How many weeks after the current one a plan may be made for. */
export const MEAL_PLAN_WEEKS_AHEAD = 4;

const WEEKDAY_ORDER: readonly Weekday[] = Object.values(Weekday);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function parseDate(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function formatDate(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10);
}

/** The calendar date (`YYYY-MM-DD`) of `now` in `timeZone`. */
export function calendarDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function addDays(date: string, days: number): string {
  return formatDate(parseDate(date) + days * DAY_MS);
}

/** The Monday of the week that holds `date`. */
export function mondayOf(date: string): string {
  const sundayFirst = new Date(parseDate(date)).getUTCDay();
  const sinceMonday = (sundayFirst + 6) % 7;
  return addDays(date, -sinceMonday);
}

/** True for a real calendar date written `YYYY-MM-DD`. */
export function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const epoch = parseDate(value);
  if (Number.isNaN(epoch)) return false;
  return formatDate(epoch) === value;
}

/** The weekday of a `YYYY-MM-DD` date. */
export function weekdayOf(date: string): Weekday {
  const sundayFirst = new Date(parseDate(date)).getUTCDay();
  return WEEKDAY_ORDER[(sundayFirst + 6) % 7];
}

/** True for a real calendar date written `YYYY-MM-DD` that is a Monday. */
export function isWeekStart(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const epoch = parseDate(value);
  if (Number.isNaN(epoch)) return false;
  if (formatDate(epoch) !== value) return false;
  return new Date(epoch).getUTCDay() === 1;
}

export interface MealWeek {
  weekStart: string;
  /** Monday of the week that holds today. */
  currentWeekStart: string;
  /** Today's date in the app time zone. */
  today: string;
  /** Last Monday a plan may be made for. */
  maxWeekStart: string;
  /** Calendar date of each weekday of this week. */
  dates: Record<Weekday, string>;
  /** Days that may still change: today and later. */
  editableDays: Weekday[];
}

export function mealWeek(
  weekStart: string | undefined,
  now: Date,
  timeZone: string,
): MealWeek {
  const today = calendarDate(now, timeZone);
  const currentWeekStart = mondayOf(today);
  const start = weekStart ?? currentWeekStart;

  const dates = {} as Record<Weekday, string>;
  const editableDays: Weekday[] = [];
  WEEKDAY_ORDER.forEach((day, index) => {
    const date = addDays(start, index);
    dates[day] = date;
    if (date >= today) editableDays.push(day);
  });

  return {
    weekStart: start,
    currentWeekStart,
    today,
    maxWeekStart: addDays(currentWeekStart, MEAL_PLAN_WEEKS_AHEAD * 7),
    dates,
    editableDays,
  };
}

/** True when no plan may be made for the week yet, because it is too far ahead. */
export function isBeyondHorizon(week: MealWeek): boolean {
  return week.weekStart > week.maxWeekStart;
}

/** The week for `weekStart` (the current week when omitted) as of now. */
export function currentMealWeek(
  weekStart?: string,
  now: Date = new Date(),
): MealWeek {
  return mealWeek(weekStart, now, runtimeConfig.APP_TIMEZONE);
}

/** Refuses a week that is further ahead than plans may be made. */
export function assertWithinHorizon(week: MealWeek): void {
  if (!isBeyondHorizon(week)) return;
  throw new StateConflictException(
    'MEAL_WEEK_OUT_OF_RANGE',
    `Plans can be made at most ${MEAL_PLAN_WEEKS_AHEAD} weeks ahead`,
    { weekStart: week.weekStart, maxWeekStart: week.maxWeekStart },
  );
}

/** Refuses a change to a day before today, and a week too far ahead. */
export function assertDaysEditable(
  week: MealWeek,
  days: readonly Weekday[],
): void {
  assertWithinHorizon(week);
  const locked = days.filter((day) => !week.editableDays.includes(day));
  if (locked.length === 0) return;
  throw new StateConflictException(
    'MEAL_DAY_LOCKED',
    'Days before today cannot be changed',
    { weekStart: week.weekStart, days: locked, today: week.today },
  );
}
