import {
  addDays,
  assertDaysEditable,
  assertWithinHorizon,
  calendarDate,
  isWeekStart,
  mealWeek,
  mondayOf,
} from '../../../src/meal-plan/meal-week.js';
import { Weekday } from '../../../src/mongo/models.js';

const ZONE = 'Asia/Bangkok';

describe('meal-week', () => {
  describe('calendarDate', () => {
    it('uses the calendar of the time zone, not UTC', () => {
      expect(calendarDate(new Date('2026-11-17T16:59:59Z'), ZONE)).toBe(
        '2026-11-17',
      );
      expect(calendarDate(new Date('2026-11-17T17:00:00Z'), ZONE)).toBe(
        '2026-11-18',
      );
    });
  });

  describe('mondayOf', () => {
    it.each([
      ['2026-11-16', '2026-11-16'],
      ['2026-11-18', '2026-11-16'],
      ['2026-11-22', '2026-11-16'],
      ['2026-11-23', '2026-11-23'],
      ['2027-01-01', '2026-12-28'],
    ])('puts %s in the week of %s', (date, monday) => {
      expect(mondayOf(date)).toBe(monday);
    });
  });

  describe('addDays', () => {
    it('crosses month and year boundaries', () => {
      expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
      expect(addDays('2026-03-02', -7)).toBe('2026-02-23');
    });
  });

  describe('isWeekStart', () => {
    it('accepts only a real Monday written YYYY-MM-DD', () => {
      expect(isWeekStart('2026-11-16')).toBe(true);
      expect(isWeekStart('2026-11-17')).toBe(false);
      expect(isWeekStart('2026-02-30')).toBe(false);
      expect(isWeekStart('2026-11-16 ')).toBe(false);
      expect(isWeekStart('16/11/2026')).toBe(false);
    });
  });

  describe('mealWeek', () => {
    const wednesday = new Date('2026-11-18T05:00:00Z');

    it('defaults to the current week and lists its dates', () => {
      const week = mealWeek(undefined, wednesday, ZONE);

      expect(week.weekStart).toBe('2026-11-16');
      expect(week.currentWeekStart).toBe('2026-11-16');
      expect(week.today).toBe('2026-11-18');
      expect(week.dates[Weekday.MON]).toBe('2026-11-16');
      expect(week.dates[Weekday.SUN]).toBe('2026-11-22');
    });

    it('lets today and later days change, and locks earlier days', () => {
      const week = mealWeek(undefined, wednesday, ZONE);

      expect(week.editableDays).toEqual([
        Weekday.WED,
        Weekday.THU,
        Weekday.FRI,
        Weekday.SAT,
        Weekday.SUN,
      ]);
    });

    it('locks every day of a past week and frees every day of a later one', () => {
      expect(mealWeek('2026-11-09', wednesday, ZONE).editableDays).toEqual([]);
      expect(mealWeek('2026-11-23', wednesday, ZONE).editableDays).toHaveLength(
        7,
      );
    });

    it('ends the horizon four weeks after the current one', () => {
      expect(mealWeek(undefined, wednesday, ZONE).maxWeekStart).toBe(
        '2026-12-14',
      );
    });
  });

  describe('assertions', () => {
    const wednesday = new Date('2026-11-18T05:00:00Z');

    it('allows the last week of the horizon and refuses the next', () => {
      expect(() =>
        assertWithinHorizon(mealWeek('2026-12-14', wednesday, ZONE)),
      ).not.toThrow();
      expect(() =>
        assertWithinHorizon(mealWeek('2026-12-21', wednesday, ZONE)),
      ).toThrowError(
        expect.objectContaining({ code: 'MEAL_WEEK_OUT_OF_RANGE' }),
      );
    });

    it('names the days that cannot change', () => {
      const week = mealWeek(undefined, wednesday, ZONE);

      expect(() =>
        assertDaysEditable(week, [Weekday.WED, Weekday.THU]),
      ).not.toThrow();
      expect(() =>
        assertDaysEditable(week, [Weekday.MON, Weekday.WED, Weekday.TUE]),
      ).toThrowError(
        expect.objectContaining({
          code: 'MEAL_DAY_LOCKED',
          details: {
            weekStart: '2026-11-16',
            days: [Weekday.MON, Weekday.TUE],
            today: '2026-11-18',
          },
        }),
      );
    });
  });
});
