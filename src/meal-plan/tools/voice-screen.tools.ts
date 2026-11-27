import { tool } from 'ai';
import { z } from 'zod';
import type { BmiCategory } from '../../mongo/models.js';
import type { DietaryService } from '../../recipes/dietary.service.js';
import { MAX_GENERATE_QUERY_LENGTH, WEEKDAYS } from '../dto/meal-plan.dto.js';
import {
  BODY_METRICS_TABS,
  RECIPE_SECTIONS,
  SCREEN_SCROLL_DIRECTIONS,
  type BodyMetricsTab,
  type MealPlanVoiceScreenDto,
  type RecipeSection,
  type ScreenScrollDirection,
} from '../dto/meal-plan-voice.dto.js';
import type { Weekday } from '../../mongo/models.js';
import type { MealPlanService } from '../meal-plan.service.js';
import type { ShoppingListService } from '../shopping-list.service.js';
import { BMI_LABELS, DAY_NAMES } from '../meal-planner.prompt.js';
import { plannableWeekStarts, weekStartInput } from './planner-weeks.js';

/**
 * Voice-mode screen control. The API validates what to show and streams a
 * transient `data-screen` event so the browser reconciles the page while the
 * voice agent talks.
 */

export interface BodyMetricsSummary {
  heightCm: number | null;
  weightKg: number | null;
  targetWeightKg: number | null;
  bmi: number | null;
  bmiCategory: BmiCategory | null;
  dailyCalorieTarget: number | null;
}

export function bodyMetricsText(metrics: BodyMetricsSummary): string {
  const parts: string[] = [];
  if (metrics.heightCm !== null) parts.push(`cao ${metrics.heightCm} cm`);
  if (metrics.weightKg !== null) parts.push(`nặng ${metrics.weightKg} kg`);
  if (metrics.bmi !== null) {
    parts.push(
      `BMI ${metrics.bmi} (${metrics.bmiCategory === null ? 'chưa phân loại' : BMI_LABELS[metrics.bmiCategory]})`,
    );
  }
  if (metrics.targetWeightKg !== null) {
    parts.push(`mục tiêu ${metrics.targetWeightKg} kg`);
  }
  if (metrics.dailyCalorieTarget !== null) {
    parts.push(`định mức ~${metrics.dailyCalorieTarget} kcal/ngày`);
  }
  if (parts.length === 0) return 'Người dùng chưa nhập chiều cao và cân nặng.';
  return `Hiện tại: ${parts.join(', ')}.`;
}

/** The views `setScreen` can put on screen; `calendar` is the calendar with no panel open. */
const SCREEN_VIEWS = [
  'calendar',
  'recipe',
  'eatingLog',
  'bodyMetrics',
  'shoppingList',
] as const;
type ScreenView = (typeof SCREEN_VIEWS)[number];

export interface SetScreenOutput {
  applied: boolean;
  view: ScreenView;
  recipeId: string | null;
  title: string | null;
  section: RecipeSection | null;
  step: number | null;
  scroll: ScreenScrollDirection | null;
  weekStart: string | null;
  day: Weekday | null;
  wholeWeek: boolean;
  people: number | null;
  checkItems: string[] | null;
  uncheckItems: string[] | null;
  clearChecked: boolean;
  tab: BodyMetricsTab | null;
  date: string | null;
  metrics: BodyMetricsSummary | null;
  /** Concise ingredient lines when view is `shoppingList`, so voice can read them aloud. */
  shoppingItems: string[] | null;
  /** Why nothing changed, worded so the agent can fix the call. */
  problem: string | null;
  done?: boolean;
}

function screenOutput(
  view: ScreenView,
  fields: Partial<Omit<SetScreenOutput, 'view'>>,
): SetScreenOutput {
  return {
    applied: true,
    view,
    recipeId: null,
    title: null,
    section: null,
    step: null,
    scroll: null,
    weekStart: null,
    day: null,
    wholeWeek: false,
    people: null,
    checkItems: null,
    uncheckItems: null,
    clearChecked: false,
    tab: null,
    date: null,
    metrics: null,
    shoppingItems: null,
    problem: null,
    ...fields,
  };
}

function screenRefusal(view: ScreenView, problem: string): SetScreenOutput {
  return screenOutput(view, { applied: false, problem });
}

const SECTION_LABELS: Record<RecipeSection, string> = {
  top: 'đầu công thức',
  ingredients: 'phần nguyên liệu',
  steps: 'phần cách làm',
};

const SCROLL_LABELS: Record<ScreenScrollDirection, string> = {
  down: 'đã cuộn xuống',
  up: 'đã cuộn lên',
  top: 'đã cuộn lên đầu',
  bottom: 'đã cuộn xuống cuối',
};

const BODY_METRICS_TAB_LABELS: Record<BodyMetricsTab, string> = {
  weekly: 'tab Tuần này (biểu đồ dinh dưỡng)',
  bmi: 'tab BMI',
  dietary: 'tab Dị ứng & Gu',
};

function setScreenText(output: SetScreenOutput): string {
  if (!output.applied) return `Màn hình chưa đổi: ${output.problem}`;
  const scrollNote =
    output.scroll === null ? '' : `, ${SCROLL_LABELS[output.scroll]}`;
  if (output.view === 'recipe') {
    const location =
      output.step !== null
        ? `, ở bước ${output.step}`
        : output.section === null
          ? ''
          : `, ở ${SECTION_LABELS[output.section]}`;
    return `Màn hình đang hiện công thức "${output.title}"${location}${scrollNote}.`;
  }
  if (output.view === 'eatingLog') {
    const day = output.date === null ? 'hôm nay' : `ngày ${output.date}`;
    return `Màn hình đang hiện nhật ký ăn uống ${day}${scrollNote}.`;
  }
  if (output.view === 'bodyMetrics') {
    const tab =
      output.tab === null ? '' : ` (${BODY_METRICS_TAB_LABELS[output.tab]})`;
    const week =
      output.weekStart === null ? '' : ` của tuần bắt đầu ${output.weekStart}`;
    const metrics =
      output.metrics === null ? '' : ` ${bodyMetricsText(output.metrics)}`;
    return `Màn hình đang hiện bảng chỉ số cơ thể${tab}${week}${scrollNote}.${metrics}`;
  }
  if (output.view === 'shoppingList') {
    const scopeParts: string[] = [];
    if (output.day !== null) scopeParts.push(DAY_NAMES[output.day]);
    else if (output.wholeWeek) scopeParts.push('cả tuần');
    if (output.weekStart !== null)
      scopeParts.push(`tuần bắt đầu ${output.weekStart}`);
    if (output.people !== null) scopeParts.push(`${output.people} người ăn`);
    const scope = scopeParts.length > 0 ? ` (${scopeParts.join(', ')})` : '';
    const checkNotes: string[] = [];
    if (output.clearChecked) checkNotes.push('đã bỏ chọn tất cả mục đã mua');
    if (output.checkItems && output.checkItems.length > 0) {
      checkNotes.push(`đã đánh dấu đã mua: ${output.checkItems.join(', ')}`);
    }
    if (output.uncheckItems && output.uncheckItems.length > 0) {
      checkNotes.push(`đã bỏ đánh dấu: ${output.uncheckItems.join(', ')}`);
    }
    const checkSuffix =
      checkNotes.length > 0 ? ` ${checkNotes.join('; ')}.` : '';
    const items = output.shoppingItems;
    if (items && items.length > 0) {
      return `Màn hình đang hiện danh sách đi chợ${scope}${scrollNote}.${checkSuffix} Nguyên liệu cần mua (${items.length} mục): ${items.join('; ')}.`;
    }
    if (items && items.length === 0) {
      return `Màn hình đang hiện danh sách đi chợ${scope}${scrollNote}.${checkSuffix} Hiện chưa có nguyên liệu nào cần mua trong phạm vi này.`;
    }
    return `Màn hình đang hiện danh sách đi chợ${scope}${scrollNote}.${checkSuffix}`;
  }
  const day =
    output.day === null
      ? ''
      : `, đang chọn ${DAY_NAMES[output.day]} của tuần bắt đầu ${output.weekStart}`;
  return `Đã đóng các bảng; màn hình đang hiện lịch${day}${scrollNote}.`;
}

/**
 * The voice agent's one screen tool: it names the view the user should see, and
 * the browser reconciles the page to it (opening a view closes the panel before).
 * Inputs that only make sense for one view are checked here, and a call that
 * cannot be shown comes back with a problem the agent can act on.
 */
export function setScreenTool(
  mealPlan: MealPlanService,
  dietary: DietaryService,
  userId: string,
  openWeekStart: string,
  screen?: MealPlanVoiceScreenDto,
  shoppingList?: ShoppingListService,
) {
  return tool({
    description: [
      "Control what the user's screen shows on /meal-planner (open, switch tab/week/day, filter, tick bought items, scroll, or close panels). The user is on a voice call with busy hands; check the screen section of your context first to see what is open now.",
      'Views (opening a view closes any previous panel):',
      '- calendar: week calendar with all panels closed. Pass day (MON..SUN) and/or weekStart (YYYY-MM-DD Monday) to navigate.',
      '- recipe: dish card with ingredients and steps. Pass recipeId or Vietnamese dish query; pass section (top/ingredients/steps) or 1-based step to jump. Omit recipeId and query to scroll the open recipe.',
      '- eatingLog: food diary. Pass date (YYYY-MM-DD) for any day (switches week automatically if needed); omit date for today.',
      '- bodyMetrics: nutrition & BMI sheet. Pass tab (weekly = calorie chart & 5 pillars, bmi = BMI/weight, dietary = allergies & preferences) and optional weekStart for another week. Already returns current BMI/target metrics.',
      '- shoppingList: shopping list. Pass weekStart for another week, day (MON..SUN for one day, or ALL for whole week), people (1-4), checkItems/uncheckItems (ingredient names), or clearChecked: true. Already fetches and returns scaled ingredients.',
      'Rules: Pass scroll (down/up/top/bottom) on any view. Pass done: true when the user only asked to control or view the screen. Call setScreen directly without getPlan because it fetches shoppingList and bodyMetrics data itself. Reserve setScreen for explicit view switches, filters, item checks, jumps, and scrolling — plan edits, logMeal, editMealLog, updateBodyMetrics, and undoLastChange already focus their target views automatically, editPlan/fillSlots edit meal slots, and endCall ends the voice call.',
    ].join('\n'),
    inputSchema: z.object({
      view: z
        .enum(SCREEN_VIEWS)
        .describe(
          'The view to show. Use calendar to close panels or go back when the user does not say what to show instead.',
        ),
      recipeId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Only with view recipe: an id from searchRecipes, getPlan, getRecipe or the screen section',
        ),
      query: z
        .string()
        .min(1)
        .max(MAX_GENERATE_QUERY_LENGTH)
        .optional()
        .describe(
          'Only with view recipe when no recipeId is in context or the calendar: Vietnamese dish name to look up and open directly',
        ),
      section: z
        .enum(RECIPE_SECTIONS)
        .optional()
        .describe(
          'Only with view recipe: the section to scroll to (top, ingredients, or steps)',
        ),
      step: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe(
          'Only with view recipe: 1-based cooking step number to scroll to and highlight',
        ),
      scroll: z
        .enum(SCREEN_SCROLL_DIRECTIONS)
        .optional()
        .describe(
          'Scroll the active view smoothly: down/up moves one viewport (~70%), top/bottom jumps to the start or end',
        ),
      weekStart: weekStartInput(plannableWeekStarts()).describe(
        'With view calendar, shoppingList, or bodyMetrics: Monday (YYYY-MM-DD) of the week to show; leave it out to stay on the current week',
      ),
      day: z
        .enum([...WEEKDAYS, 'ALL'] as const)
        .optional()
        .describe(
          'With view calendar: MON..SUN to select a day. With view shoppingList: MON..SUN for one day, or ALL for the whole week (Cả tuần).',
        ),
      people: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe(
          'Only with view shoppingList: number of eaters (1 to 4) to scale ingredient quantities',
        ),
      checkItems: z
        .array(z.string().min(1).max(80))
        .max(20)
        .optional()
        .describe(
          'Only with view shoppingList: ingredient names to tick off as bought',
        ),
      uncheckItems: z
        .array(z.string().min(1).max(80))
        .max(20)
        .optional()
        .describe('Only with view shoppingList: ingredient names to untick'),
      clearChecked: z
        .boolean()
        .optional()
        .describe(
          'Only with view shoppingList: set true to untick all bought items',
        ),
      tab: z
        .enum(BODY_METRICS_TABS)
        .optional()
        .describe(
          'Only with view bodyMetrics: which tab to open (weekly = calorie chart & 5 pillars, bmi = BMI & weight, dietary = allergies & preferences)',
        ),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(
          'Only with view eatingLog: the day to show, YYYY-MM-DD; leave it out for today',
        ),
      done: z
        .boolean()
        .optional()
        .describe(
          'Set to true when the user only asked to open, close, filter, or scroll the screen and needs no further analysis',
        ),
    }),
    execute: async (input): Promise<SetScreenOutput> => {
      const doneFlag = input.done === true ? { done: true } : {};
      const scroll = input.scroll ?? null;
      if (input.view === 'recipe') {
        let recipeId = input.recipeId;
        let title: string | null = null;
        if (!recipeId && input.query) {
          const matches = await mealPlan.suggestions(userId, input.query);
          const first = matches[0];
          if (!first) {
            return screenRefusal(
              'recipe',
              `no recipe matched "${input.query}"; search with searchRecipes or tell the user it is not in the catalog.`,
            );
          }
          recipeId = first.id;
          title = first.title;
        }
        if (!recipeId) {
          recipeId = screen?.recipeId;
        }
        if (recipeId === undefined) {
          return screenRefusal(
            'recipe',
            'view recipe needs recipeId or query; find the dish with searchRecipes or pass its name in query.',
          );
        }
        if (title === null) {
          const recipe = await mealPlan.recipeInstructions(userId, recipeId);
          if (recipe === null) {
            return screenRefusal(
              'recipe',
              `no recipe has id ${recipeId}; look it up with searchRecipes.`,
            );
          }
          title = recipe.title;
        }
        const step = input.step ?? null;
        const section = input.section ?? (step !== null ? 'steps' : null);
        return screenOutput('recipe', {
          recipeId,
          title,
          section,
          step,
          scroll,
          ...doneFlag,
        });
      }
      if (input.view === 'eatingLog') {
        return screenOutput('eatingLog', {
          date: input.date ?? null,
          scroll,
          ...doneFlag,
        });
      }
      if (input.view === 'bodyMetrics') {
        const profile = await dietary.findNutrition(userId);
        return screenOutput('bodyMetrics', {
          tab: input.tab ?? null,
          weekStart: input.weekStart ?? null,
          metrics: {
            heightCm: profile.heightCm,
            weightKg: profile.weightKg,
            targetWeightKg: profile.targetWeightKg,
            bmi: profile.bmi,
            bmiCategory: profile.bmiCategory,
            dailyCalorieTarget: profile.dailyCalorieTarget,
          },
          scroll,
          ...doneFlag,
        });
      }
      if (input.view === 'shoppingList') {
        const targetWeek =
          input.weekStart ?? screen?.weekStart ?? openWeekStart;
        const pickedDay: Weekday | null =
          input.day && input.day !== 'ALL' ? input.day : null;
        let targetDays: Weekday[];
        if (pickedDay) {
          targetDays = [pickedDay];
        } else if (input.day === 'ALL') {
          targetDays = [...WEEKDAYS];
        } else if (
          screen?.panel === 'shoppingList' &&
          screen.shoppingDays &&
          screen.shoppingDays.length > 0 &&
          input.weekStart === undefined
        ) {
          targetDays = screen.shoppingDays;
        } else {
          targetDays = [...WEEKDAYS];
        }
        const targetPeople = input.people ?? screen?.shoppingPeople ?? 1;
        let shoppingItems: string[] | null = null;
        if (shoppingList) {
          const list = await shoppingList.get(userId, {
            weekStart: targetWeek,
            days: targetDays,
          });
          shoppingItems = list.items.slice(0, 20).map((item) => {
            let scaledSum = 0;
            let knownCount = 0;
            for (const contrib of item.contributions) {
              if (contrib.quantity === null) continue;
              const numeric = Number(contrib.quantity);
              if (!Number.isFinite(numeric)) continue;
              const divisor = contrib.servings > 0 ? contrib.servings : 1;
              scaledSum += (numeric / divisor) * targetPeople;
              knownCount += 1;
            }
            const rounded = Math.round(scaledSum * 100) / 100;
            const qty =
              knownCount > 0
                ? [rounded, item.unit].filter(Boolean).join(' ')
                : 'chưa rõ lượng';
            return `${item.name} (${qty})`;
          });
        }
        const wholeWeek =
          input.day === 'ALL' ||
          (!pickedDay && targetDays.length === WEEKDAYS.length);
        return screenOutput('shoppingList', {
          weekStart: targetWeek,
          day: pickedDay ?? (targetDays.length === 1 ? targetDays[0] : null),
          wholeWeek,
          people: input.people ?? null,
          checkItems: input.checkItems ?? null,
          uncheckItems: input.uncheckItems ?? null,
          clearChecked: input.clearChecked === true,
          shoppingItems,
          scroll,
          ...doneFlag,
        });
      }
      return screenOutput('calendar', {
        weekStart: input.weekStart ?? screen?.weekStart ?? openWeekStart,
        day: input.day && input.day !== 'ALL' ? input.day : null,
        scroll,
        ...doneFlag,
      });
    },
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: setScreenText(output),
    }),
  });
}
