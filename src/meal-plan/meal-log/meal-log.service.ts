import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { aiFailure } from '../../ai/provider-failure.js';
import { aiCostContext } from '../../ai/telemetry/ai-cost-context.js';
import { StateConflictException } from '../../common/exceptions/state-conflict.exception.js';
import { InvalidInputException } from '../../common/exceptions/invalid-input.exception.js';
import { QuotaReachedException } from '../../common/exceptions/quota-reached.exception.js';
import { ResourceNotFoundException } from '../../common/exceptions/resource-not-found.exception.js';
import { runtimeConfig } from '../../config/runtime-config.js';
import {
  AiFeature,
  CalorieSource,
  MealLogEntry,
  MealLogSource,
  MealPlanEntry,
  MealSection,
  Weekday,
} from '../../mongo/models.js';
import { rethrowAsStateConflict } from '../../mongo/unique-conflict.js';
import { DietaryService } from '../../recipes/dietary.service.js';
import { AiUsageService } from '../../subscriptions/ai-usage.service.js';
import { MEAL_SECTIONS } from '../dto/meal-plan.dto.js';
import type {
  CalorieEstimateDto,
  CalorieReferenceDto,
  ClientCalorieSource,
  CreateMealLogEntryDto,
  EstimateCaloriesDto,
  MealLogDayDto,
  MealLogEntryDto,
  MealLogWeekDto,
  UpdateMealLogEntryDto,
} from '../dto/meal-log.dto.js';
import { MealPlanService } from '../meal-plan.service.js';
import {
  addDays,
  calendarDate,
  currentMealWeek,
  mondayOf,
  weekdayOf,
} from '../meal-week.js';
import { CalorieEstimator } from './calorie-estimator.js';

type Calories = Pick<
  MealLogEntry,
  'caloriesPerServing' | 'calorieSource' | 'calorieNote' | 'calorieReferences'
>;

const NO_CALORIES: Calories = {
  caloriesPerServing: null,
  calorieSource: null,
  calorieNote: null,
  calorieReferences: [],
};

/** Calories the client sent, with references kept only for a web estimate. */
function clientCalories(
  caloriesPerServing: number,
  source: ClientCalorieSource | undefined,
  note: string | undefined,
  references: CalorieReferenceDto[] | undefined,
): Calories {
  const calorieSource = source ?? CalorieSource.USER;
  const isWeb = calorieSource === CalorieSource.WEB_ESTIMATE;
  return {
    caloriesPerServing,
    calorieSource,
    calorieNote: note?.trim() || null,
    calorieReferences: isWeb ? (references ?? []) : [],
  };
}

export function totalCalories(entry: {
  caloriesPerServing: number | null;
  servings: number;
}): number | null {
  if (entry.caloriesPerServing === null) return null;
  return Math.round(entry.caloriesPerServing * entry.servings);
}

function toEntryDto(entry: MealLogEntry): MealLogEntryDto {
  return {
    id: entry._id,
    date: entry.date,
    section: entry.section,
    source: entry.source,
    recipeId: entry.recipeId,
    name: entry.name,
    servings: entry.servings,
    caloriesPerServing: entry.caloriesPerServing,
    calories: totalCalories(entry),
    calorieSource: entry.calorieSource,
    calorieNote: entry.calorieNote,
    calorieReferences: entry.calorieReferences.map(({ title, url }) => ({
      title,
      url,
    })),
    createdAt: entry.createdAt.toISOString(),
  };
}

const EDITABLE_DAYS = runtimeConfig.MEAL_LOG_EDITABLE_DAYS;
const MAX_ENTRIES_PER_MEAL = runtimeConfig.MEAL_LOG_MAX_ENTRIES_PER_MEAL;

/** Days the log may change: today and the `EDITABLE_DAYS` before it. */
interface LogWindow {
  today: string;
  oldestDate: string;
}

function logWindow(now: Date): LogWindow {
  const today = calendarDate(now, runtimeConfig.APP_TIMEZONE);
  return { today, oldestDate: addDays(today, -EDITABLE_DAYS) };
}

function isInWindow(date: string, window: LogWindow): boolean {
  return date >= window.oldestDate && date <= window.today;
}

function assertInWindow(date: string, window: LogWindow): void {
  if (isInWindow(date, window)) return;
  throw new StateConflictException(
    'MEAL_LOG_LOCKED',
    `Only today and the ${EDITABLE_DAYS} days before it can be logged`,
    { date, oldestDate: window.oldestDate, today: window.today },
  );
}

function sectionOrder(section: MealSection): number {
  return MEAL_SECTIONS.indexOf(section);
}

/** What the user ate, beside the plan of what they meant to eat. */
@Injectable()
export class MealLogService {
  constructor(
    @InjectModel(MealLogEntry.name)
    private readonly entries: Model<MealLogEntry>,
    @InjectModel(MealPlanEntry.name)
    private readonly planEntries: Model<MealPlanEntry>,
    private readonly mealPlan: MealPlanService,
    private readonly dietary: DietaryService,
    private readonly usage: AiUsageService,
    private readonly estimator: CalorieEstimator,
  ) {}

  /** The log of one week beside its plan and the user's calorie target. */
  async week(
    userId: string,
    weekStart?: string,
    now: Date = new Date(),
  ): Promise<MealLogWeekDto> {
    const week = currentMealWeek(weekStart, now);
    const window = logWindow(now);
    const lastDate = week.dates[Weekday.SUN];
    const [rows, plan, nutrition] = await Promise.all([
      this.entries
        .find({ userId, date: { $gte: week.weekStart, $lte: lastDate } })
        .sort({ date: 1, createdAt: 1, _id: 1 })
        .exec(),
      this.mealPlan.find(userId, week.weekStart),
      Promise.resolve(this.dietary.findNutrition(userId)).then(
        (value) => value ?? null,
      ),
    ]);

    const byDate = new Map<string, MealLogEntry[]>();
    for (const row of rows) {
      const list = byDate.get(row.date) ?? [];
      list.push(row);
      byDate.set(row.date, list);
    }

    const days: MealLogDayDto[] = [];
    for (const planDay of plan.days) {
      const dayRows = byDate.get(planDay.date) ?? [];
      dayRows.sort((a, b) => sectionOrder(a.section) - sectionOrder(b.section));
      let loggedCalories = 0;
      let unknownCalorieEntries = 0;
      for (const row of dayRows) {
        const calories = totalCalories(row);
        if (calories === null) unknownCalorieEntries += 1;
        else loggedCalories += calories;
      }
      let plannedCalories: number | null = null;
      for (const { recipes } of planDay.sections) {
        for (const recipe of recipes) {
          plannedCalories =
            (plannedCalories ?? 0) + (recipe.caloriesPerServing ?? 0);
        }
      }
      days.push({
        day: planDay.day,
        date: planDay.date,
        loggable: isInWindow(planDay.date, window),
        entries: dayRows.map(toEntryDto),
        loggedCalories,
        unknownCalorieEntries,
        plannedCalories,
      });
    }

    // Today is still going, and a day with an unknown dish would read low:
    // the average covers finished days whose every dish has calories.
    let loggedDays = 0;
    let completeDays = 0;
    let completeSum = 0;
    let remainingDays = 0;
    for (const day of days) {
      if (day.date >= week.today) remainingDays += 1;
      if (day.date > week.today || day.entries.length === 0) continue;
      loggedDays += 1;
      if (day.date === week.today || day.unknownCalorieEntries > 0) continue;
      completeDays += 1;
      completeSum += day.loggedCalories;
    }

    return {
      weekStart: week.weekStart,
      today: week.today,
      dailyCalorieTarget: nutrition?.dailyCalorieTarget ?? null,
      dailyCalorieMin: nutrition?.dailyCalorieMin ?? null,
      dailyCalorieMax: nutrition?.dailyCalorieMax ?? null,
      days,
      summary: {
        loggedDays,
        completeDays,
        averageCalories:
          completeDays > 0 ? Math.round(completeSum / completeDays) : null,
        remainingDays,
      },
    };
  }

  async create(
    userId: string,
    dto: CreateMealLogEntryDto,
    now: Date = new Date(),
  ): Promise<MealLogEntryDto> {
    assertInWindow(dto.date, logWindow(now));
    const name = dto.name?.trim() ?? '';
    if (dto.recipeId && name) {
      throw new InvalidInputException(
        'BAD_REQUEST',
        'Send either recipeId or name, not both',
      );
    }
    if (!dto.recipeId && !name) {
      throw new InvalidInputException('BAD_REQUEST', 'Send recipeId or name');
    }

    const base = {
      _id: randomUUID(),
      userId,
      date: dto.date,
      section: dto.section,
      servings: dto.servings ?? 1,
    };
    await this.assertMealHasRoom(userId, dto.date, dto.section);
    const fields = dto.recipeId
      ? await this.recipeFields(userId, dto, dto.recipeId)
      : { ...this.customFields(dto), name };

    try {
      const created = await this.entries.create({ ...base, ...fields });
      return toEntryDto(created);
    } catch (error) {
      rethrowAsStateConflict(
        error,
        'CONFLICT',
        'This dish is already logged for that meal; change its servings instead',
      );
    }
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateMealLogEntryDto,
    now: Date = new Date(),
  ): Promise<MealLogEntryDto> {
    const entry = await this.entries.findOne({ _id: id, userId }).exec();
    if (!entry) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Log entry not found');
    }
    assertInWindow(entry.date, logWindow(now));
    if (dto.section !== undefined && dto.section !== entry.section) {
      await this.assertMealHasRoom(userId, entry.date, dto.section);
    }
    if (dto.name !== undefined) {
      if (entry.source !== MealLogSource.CUSTOM) {
        throw new InvalidInputException(
          'BAD_REQUEST',
          'Only a custom dish can be renamed',
        );
      }
      entry.name = dto.name.trim();
    }
    if (dto.section !== undefined) entry.section = dto.section;
    if (dto.servings !== undefined) entry.servings = dto.servings;
    if (dto.caloriesPerServing === null) {
      entry.set(NO_CALORIES);
    } else if (dto.caloriesPerServing !== undefined) {
      entry.set(
        clientCalories(
          dto.caloriesPerServing,
          dto.calorieSource,
          dto.calorieNote,
          dto.calorieReferences,
        ),
      );
    } else if (dto.calorieNote !== undefined) {
      entry.calorieNote = dto.calorieNote.trim() || null;
    }

    try {
      await entry.save();
    } catch (error) {
      rethrowAsStateConflict(
        error,
        'CONFLICT',
        'This dish is already logged for that meal',
      );
    }
    return toEntryDto(entry);
  }

  async remove(
    userId: string,
    id: string,
    now: Date = new Date(),
  ): Promise<void> {
    const entry = await this.entries
      .findOne({ _id: id, userId })
      .select('date')
      .exec();
    if (!entry) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Log entry not found');
    }
    assertInWindow(entry.date, logWindow(now));
    await this.entries.deleteOne({ _id: id, userId }).exec();
  }

  /** Asks AI to look a dish's calories up on the web. Nothing is saved. */
  async estimateCalories(
    userId: string,
    dto: EstimateCaloriesDto,
  ): Promise<CalorieEstimateDto> {
    const question = { name: dto.name.trim(), details: dto.details?.trim() };
    const ticket = await this.usage.consume(userId, AiFeature.MEAL_PLAN_CHAT, {
      input: question,
      prompt: question.name,
    });
    if (!ticket) {
      throw new QuotaReachedException(
        'AI_QUOTA_EXCEEDED',
        'Your shared AI text allowance is exhausted',
      );
    }
    const executionId = randomUUID();
    const context = {
      feature: 'MEAL_LOG',
      userId,
      executionId,
      turnId: executionId,
    };
    try {
      const estimate = await aiCostContext.run(context, () =>
        this.estimator.estimate(question),
      );
      await this.usage.complete(ticket);
      return estimate;
    } catch (error: unknown) {
      await this.usage.refund(ticket);
      throw aiFailure('Calorie estimate', error);
    }
  }

  private async assertMealHasRoom(
    userId: string,
    date: string,
    section: MealSection,
  ): Promise<void> {
    const count = await this.entries
      .countDocuments({ userId, date, section })
      .exec();
    if (count < MAX_ENTRIES_PER_MEAL) return;
    throw new StateConflictException(
      'MEAL_LOG_FULL',
      `A meal holds at most ${MAX_ENTRIES_PER_MEAL} dishes`,
      { date, section, max: MAX_ENTRIES_PER_MEAL },
    );
  }

  private async recipeFields(
    userId: string,
    dto: CreateMealLogEntryDto,
    recipeId: string,
  ): Promise<Calories & Pick<MealLogEntry, 'source' | 'recipeId' | 'name'>> {
    const [recipe, planned] = await Promise.all([
      this.mealPlan.recipeInstructions(userId, recipeId),
      this.planEntries.exists({
        userId,
        weekStart: mondayOf(dto.date),
        day: weekdayOf(dto.date),
        section: dto.section,
        recipeId,
      }),
    ]);
    if (!recipe) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Recipe not found');
    }
    const source = planned ? MealLogSource.PLAN : MealLogSource.RECIPE;
    const link = { source, recipeId, name: recipe.title };
    if (dto.caloriesPerServing !== undefined) {
      return {
        ...link,
        ...clientCalories(
          dto.caloriesPerServing,
          dto.calorieSource,
          dto.calorieNote,
          dto.calorieReferences,
        ),
      };
    }
    const recipeCalories = recipe.caloriesPerServing ?? null;
    if (recipeCalories === null) return { ...link, ...NO_CALORIES };
    return {
      ...link,
      ...NO_CALORIES,
      caloriesPerServing: recipeCalories,
      calorieSource: CalorieSource.RECIPE,
    };
  }

  private customFields(
    dto: CreateMealLogEntryDto,
  ): Calories & Pick<MealLogEntry, 'source' | 'recipeId'> {
    const link = { source: MealLogSource.CUSTOM, recipeId: null };
    if (dto.caloriesPerServing === undefined)
      return { ...link, ...NO_CALORIES };
    return {
      ...link,
      ...clientCalories(
        dto.caloriesPerServing,
        dto.calorieSource,
        dto.calorieNote,
        dto.calorieReferences,
      ),
    };
  }
}
