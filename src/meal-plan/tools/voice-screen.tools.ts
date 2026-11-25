import { tool } from 'ai';
import { z } from 'zod';
import type { BmiCategory } from '../../mongo/models.js';
import type { DietaryService } from '../../recipes/dietary.service.js';
import { WEEKDAYS } from '../dto/meal-plan.dto.js';
import {
  RECIPE_SECTIONS,
  type RecipeSection,
  type MealPlanVoiceScreenDto,
} from '../dto/meal-plan-voice.dto.js';
import type { Weekday } from '../../mongo/models.js';
import type { MealPlanService } from '../meal-plan.service.js';
import { BMI_LABELS, DAY_NAMES } from '../meal-planner.prompt.js';
import { plannableWeekStarts, weekStartInput } from './planner-weeks.js';

/**
 * Voice-mode screen control. The API only checks what to show; the browser reads
 * the tool output from the voice turn and puts the page in that state while the
 * voice agent talks. `setScreen` is the tool the agent gets; the older one-panel
 * tools stay defined only so threads that used them still validate.
 */

/** Parts of a recipe card the legacy `showRecipe` could scroll to. */
const LEGACY_RECIPE_SECTIONS = ['ingredients', 'steps'] as const;

/** What `closeScreen` can close; `all` closes whatever is open. */
const SCREEN_PANELS = ['recipe', 'eatingLog', 'bodyMetrics', 'all'] as const;

const PANEL_NAMES: Record<(typeof SCREEN_PANELS)[number], string> = {
  recipe: 'công thức',
  eatingLog: 'nhật ký ăn uống',
  bodyMetrics: 'bảng chỉ số cơ thể',
  all: 'các bảng đang mở',
};

export function showRecipeTool(mealPlan: MealPlanService, userId: string) {
  return tool({
    description:
      "Show one recipe card (ingredients, steps) on the user's screen. Use it whenever you talk about a specific dish, so the user can read along instead of remembering what you said. Pass an id from searchRecipes, getPlan or getRecipe. Pass section to scroll the card to the ingredients or the steps, which helps when the user is cooking and asks what they need or what comes next; calling it again for the recipe already open only scrolls it.",
    inputSchema: z.object({
      recipeId: z
        .string()
        .min(1)
        .describe('A recipe id from searchRecipes or getPlan'),
      section: z
        .enum(LEGACY_RECIPE_SECTIONS)
        .optional()
        .describe('Part of the card to scroll to; leave it out for the top'),
    }),
    execute: async ({ recipeId, section }) => {
      const recipe = await mealPlan.recipeInstructions(userId, recipeId);
      if (recipe === null) {
        return { shown: false, recipeId, title: null, section: null };
      }
      return {
        shown: true,
        recipeId,
        title: recipe.title,
        section: section ?? null,
      };
    },
    toModelOutput: ({ output }) => {
      if (!output.shown) {
        return { type: 'text', value: 'Recipe not found; nothing was shown.' };
      }
      return {
        type: 'text',
        value: `Đã mở công thức "${output.title}" trên màn hình.`,
      };
    },
  });
}

export function closeScreenTool() {
  return tool({
    description:
      "Close a panel on the user's screen: the recipe card, the food diary, the body metrics panel, or everything that is open. Use it when the user asks to close, hide or go back from what is shown; in a voice call they have no free hand to tap the close button. The show tools already close the previous panel when they open a new one, so call this only when the user wants the screen cleared.",
    inputSchema: z.object({
      panel: z
        .enum(SCREEN_PANELS)
        .default('all')
        .describe('The panel to close; all when the user does not say which'),
    }),
    execute: ({ panel }) => ({ closed: panel }),
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: `Đã đóng ${PANEL_NAMES[output.closed]} trên màn hình.`,
    }),
  });
}

export function showPlanDayTool(openWeekStart: string) {
  return tool({
    description:
      "Show one day of a week on the user's calendar, switching week if needed. It changes nothing in the plan. Use it when the user wants to look at a day or another week, such as next Wednesday. Plan tools already show the day they change, so it is for looking only.",
    inputSchema: z.object({
      day: z.enum(WEEKDAYS).describe('The day to show'),
      weekStart: weekStartInput(plannableWeekStarts()),
    }),
    execute: ({ day, weekStart }) => ({
      weekStart: weekStart ?? openWeekStart,
      day,
    }),
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: `Đã hiện ${DAY_NAMES[output.day]} của tuần bắt đầu ${output.weekStart} trên lịch.`,
    }),
  });
}

export function openEatingLogTool() {
  return tool({
    description:
      "Open the food diary (what the user ate this week) on the user's screen. Call it when the user asks about their diary, after logMeal, or when you review what they ate.",
    inputSchema: z.object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('The day to focus, YYYY-MM-DD; leave it out for today'),
    }),
    execute: ({ date }) => ({ opened: true, date: date ?? null }),
    toModelOutput: () => ({
      type: 'text',
      value: 'Đã mở nhật ký ăn uống trên màn hình.',
    }),
  });
}

export function showBodyMetricsTool(dietary: DietaryService, userId: string) {
  return tool({
    description:
      "Show the user's body metrics panel (BMI, weight, target weight, daily kcal target) on screen and read the current values. Call it when the user asks about BMI, weight or their calorie target.",
    inputSchema: z.object({}),
    execute: async () => {
      const profile = await dietary.findNutrition(userId);
      return {
        shown: true,
        heightCm: profile.heightCm,
        weightKg: profile.weightKg,
        targetWeightKg: profile.targetWeightKg,
        bmi: profile.bmi,
        bmiCategory: profile.bmiCategory,
        dailyCalorieTarget: profile.dailyCalorieTarget,
      };
    },
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: `Đã hiện bảng chỉ số cơ thể. ${bodyMetricsText(output)}`,
    }),
  });
}

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
] as const;
type ScreenView = (typeof SCREEN_VIEWS)[number];

export interface SetScreenOutput {
  applied: boolean;
  view: ScreenView;
  recipeId: string | null;
  title: string | null;
  section: RecipeSection | null;
  weekStart: string | null;
  day: Weekday | null;
  date: string | null;
  metrics: BodyMetricsSummary | null;
  /** Why nothing changed, worded so the agent can fix the call. */
  problem: string | null;
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
    weekStart: null,
    day: null,
    date: null,
    metrics: null,
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

function setScreenText(output: SetScreenOutput): string {
  if (!output.applied) return `Màn hình chưa đổi: ${output.problem}`;
  if (output.view === 'recipe') {
    const section =
      output.section === null ? '' : `, ở ${SECTION_LABELS[output.section]}`;
    return `Màn hình đang hiện công thức "${output.title}"${section}.`;
  }
  if (output.view === 'eatingLog') {
    const day = output.date === null ? 'hôm nay' : `ngày ${output.date}`;
    return `Màn hình đang hiện nhật ký ăn uống ${day}.`;
  }
  if (output.view === 'bodyMetrics') {
    const metrics =
      output.metrics === null ? '' : ` ${bodyMetricsText(output.metrics)}`;
    return `Màn hình đang hiện bảng chỉ số cơ thể.${metrics}`;
  }
  const day =
    output.day === null
      ? ''
      : `, đang chọn ${DAY_NAMES[output.day]} của tuần bắt đầu ${output.weekStart}`;
  return `Đã đóng các bảng; màn hình đang hiện lịch${day}.`;
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
) {
  return tool({
    description:
      "Change what the user's screen shows by naming the view they should see. The user is on a call and often has busy hands, so you are the one who opens, scrolls and closes things for them; the screen section of your context says what they see right now. Views: calendar is the week calendar with every panel closed (pass day, and weekStart for another week, to pick a day); recipe is one recipe card with its ingredients and steps (pass recipeId, and section to scroll to the ingredients or the steps; for the recipe already open this only scrolls); eatingLog is the food diary (pass date for a day other than today); bodyMetrics is the BMI, weight and daily kcal panel, and it also returns the current values. Opening a view closes the panel that was open before. It changes nothing the user has saved, and plan changes already show the day they changed.",
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
      section: z
        .enum(RECIPE_SECTIONS)
        .optional()
        .describe(
          'Only with view recipe: the part to scroll to, for example steps when the user asks what comes next while cooking',
        ),
      weekStart: weekStartInput(plannableWeekStarts()).describe(
        'Only with view calendar: Monday (YYYY-MM-DD) of the week to show; leave it out to stay on the week shown now',
      ),
      day: z
        .enum(WEEKDAYS)
        .optional()
        .describe('Only with view calendar: the day to select'),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(
          'Only with view eatingLog: the day to show, YYYY-MM-DD; leave it out for today',
        ),
    }),
    execute: async (input): Promise<SetScreenOutput> => {
      if (input.view === 'recipe') {
        const recipeId = input.recipeId ?? screen?.recipeId;
        if (recipeId === undefined) {
          return screenRefusal(
            'recipe',
            'view recipe needs recipeId; find the dish with searchRecipes or getPlan first.',
          );
        }
        const recipe = await mealPlan.recipeInstructions(userId, recipeId);
        if (recipe === null) {
          return screenRefusal(
            'recipe',
            `no recipe has id ${recipeId}; look it up with searchRecipes.`,
          );
        }
        return screenOutput('recipe', {
          recipeId,
          title: recipe.title,
          section: input.section ?? null,
        });
      }
      if (input.view === 'eatingLog') {
        return screenOutput('eatingLog', { date: input.date ?? null });
      }
      if (input.view === 'bodyMetrics') {
        const profile = await dietary.findNutrition(userId);
        return screenOutput('bodyMetrics', {
          metrics: {
            heightCm: profile.heightCm,
            weightKg: profile.weightKg,
            targetWeightKg: profile.targetWeightKg,
            bmi: profile.bmi,
            bmiCategory: profile.bmiCategory,
            dailyCalorieTarget: profile.dailyCalorieTarget,
          },
        });
      }
      return screenOutput('calendar', {
        weekStart: input.weekStart ?? screen?.weekStart ?? openWeekStart,
        day: input.day ?? null,
      });
    },
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: setScreenText(output),
    }),
  });
}

/** The one-panel screen tools of earlier voice turns, kept so their threads still validate. */
export function legacyVoiceScreenTools(
  mealPlan: MealPlanService,
  dietary: DietaryService,
  userId: string,
  openWeekStart: string,
) {
  return {
    showRecipe: showRecipeTool(mealPlan, userId),
    showPlanDay: showPlanDayTool(openWeekStart),
    closeScreen: closeScreenTool(),
    openEatingLog: openEatingLogTool(),
    showBodyMetrics: showBodyMetricsTool(dietary, userId),
  };
}
