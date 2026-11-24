import { Logger } from '@nestjs/common';
import { generateText, type LanguageModel, Output, tool } from 'ai';
import { z } from 'zod';
import { OpenRouterCacheControl } from '../../ai/openrouter.js';
import { MealSection, Weekday } from '../../mongo/models.js';
import type { DietaryRestrictionsDto } from '../../recipes/dto/dietary.dto.js';
import { extractAllergyKeywords } from '../../recipes/nutrition.js';
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
import { ALLERGY_AUDIT_INSTRUCTIONS } from './allergy-verifier.prompt.js';

const logger = new Logger('AllergyVerifierSubagentTool');

type RecipeDetails = NonNullable<
  Awaited<ReturnType<MealPlanService['recipeInstructions']>>
>;

const allergyAuditSchema = z.object({
  flagged: z
    .array(
      z.object({
        recipeId: z.string(),
        reason: z
          .string()
          .describe(
            'Lý do ngắn gọn bằng tiếng Việt món này vi phạm dị ứng/lưu ý',
          ),
      }),
    )
    .describe(
      'Only recipes that genuinely contain or risk triggering an allergen or restriction',
    ),
  summary: z
    .string()
    .describe('Tóm tắt kết quả kiểm định ngắn gọn bằng tiếng Việt'),
});

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
  summary: string;
  /** Set when flagged dishes were replaced: what changed in the saved plan. */
  weekStart?: string;
  days?: PlanChange['days'];
  problems?: PlanChange['problems'];
  applied?: boolean;
}

function editableSlots(
  plan: Awaited<ReturnType<MealPlanService['find']>>,
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

function recipeHaystack(recipe: RecipeDetails): string {
  const ingredientText = recipe.ingredients
    .map((item) => `${item.name} ${item.note ?? ''}`)
    .join(' ');
  return [
    recipe.title,
    recipe.description ?? '',
    ingredientText,
    ...recipe.steps,
  ]
    .join(' ')
    .normalize('NFC')
    .toLowerCase();
}

async function runSemanticAllergyAudit(
  model: LanguageModel,
  combinedNotes: string,
  avoidedTerms: readonly string[],
  recipes: RecipeDetails[],
  abortSignal?: AbortSignal,
): Promise<{
  flagged: { recipeId: string; reason: string }[];
  summary?: string;
}> {
  const recipeLines = recipes.map((recipe) => {
    const ingredients = recipe.ingredients
      .map((item) => (item.note ? `${item.name} (${item.note})` : item.name))
      .join(', ');
    const steps = recipe.steps.join(' ');
    return `- id=${recipe.id} | ${recipe.title} | Nguyên liệu: ${ingredients} | Cách làm: ${steps}`;
  });

  const { output } = await generateText({
    model,
    output: Output.object({ schema: allergyAuditSchema }),
    ...OpenRouterCacheControl.singleTurn({
      session: 'vedora-allergy-verifier',
      instructions: ALLERGY_AUDIT_INSTRUCTIONS,
      // A missed allergen is a safety failure; this call is rare and short.
      effort: 'high',
      // Runs inside a meal planner session: 5m, like the planner.
      ttl: '5m',
    }),
    prompt: [
      `<allergy_profile>`,
      `Thực phẩm người dùng tránh trong hồ sơ có cấu trúc: ${avoidedTerms.length > 0 ? avoidedTerms.join(', ') : 'không có'}.`,
      `Mô tả dị ứng & lưu ý ăn uống tự nhiên: ${combinedNotes || 'không có mô tả thêm'}.`,
      `</allergy_profile>`,
      `<recipes>\n${recipeLines.join('\n')}\n</recipes>`,
    ].join('\n\n'),
    abortSignal,
  });

  return { flagged: output.flagged, summary: output.summary };
}

/**
 * Dedicated Allergy Verification Subagent tool: audits every dish in the active
 * week's saved plan against natural-language allergy notes and
 * automatically swaps out unsafe dishes while keeping safe selections intact.
 */
export function verifyMealPlanAllergiesTool(
  model: LanguageModel,
  mealPlan: MealPlanService,
  userId: string,
  openWeekStart: string,
  restrictions: DietaryRestrictionsDto,
) {
  return tool({
    description:
      'Run the Allergy Verification Subagent on the week’s plan to inspect every dish’s full ingredient list and cooking steps against the user’s natural-language dietary/allergy profile. Use it after you build or change a plan when the user has an allergy note or mentioned an allergy. Replaces any flagged allergen dish with a safe alternative in the saved plan (the user can rewind it from the chat); set replaceFlagged: false to only report when the user asked for a check, not a change.',
    inputSchema: z.object({
      weekStart: weekStartInput(plannableWeekStarts()),
      allergyDescription: z
        .string()
        .max(1000)
        .optional()
        .describe(
          'Optional allergy or intolerance description mentioned in the chat turn to combine with the saved allergyNote',
        ),
      replaceFlagged: z
        .boolean()
        .optional()
        .describe(
          'Automatically replace any flagged dish with a safe alternative (default true)',
        ),
    }),
    execute: async (
      { weekStart, allergyDescription, replaceFlagged },
      { abortSignal },
    ): Promise<AllergyVerificationResult> => {
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
          summary: 'Tuần này chưa có món nào trên lịch để kiểm định dị ứng.',
        };
      }

      const loaded = await Promise.all(
        uniqueIds.map((id) => mealPlan.recipeInstructions(userId, id)),
      );
      const recipeMap = new Map<string, RecipeDetails>();
      for (const item of loaded) {
        if (item) recipeMap.set(item.id, item);
      }

      const combinedNotes = [restrictions.allergyNote, allergyDescription]
        .filter((value): value is string => Boolean(value && value.trim()))
        .join(' | ');
      const avoidedTerms = [
        ...restrictions.groups.map((item) => item.name),
        ...restrictions.ingredients.map((item) => item.name),
      ];
      const keywords = extractAllergyKeywords(combinedNotes);

      const flaggedReasons = new Map<string, string>();
      for (const recipe of recipeMap.values()) {
        if (recipe.avoidedIngredients.length > 0) {
          flaggedReasons.set(
            recipe.id,
            `Chứa thành phần tránh: ${recipe.avoidedIngredients.join(', ')}`,
          );
          continue;
        }
        if (keywords.length > 0) {
          const text = recipeHaystack(recipe);
          const matched = keywords.filter((word) => text.includes(word));
          if (matched.length > 0) {
            flaggedReasons.set(
              recipe.id,
              `Khớp từ khóa dị ứng/kiêng kỵ: ${matched.slice(0, 3).join(', ')}`,
            );
          }
        }
      }

      const unflaggedRecipes: RecipeDetails[] = [];
      for (const recipe of recipeMap.values()) {
        if (!flaggedReasons.has(recipe.id)) unflaggedRecipes.push(recipe);
      }

      let subagentSummary = '';
      if (combinedNotes.trim().length > 0 && unflaggedRecipes.length > 0) {
        try {
          const audit = await runSemanticAllergyAudit(
            model,
            combinedNotes,
            avoidedTerms,
            unflaggedRecipes,
            abortSignal,
          );
          subagentSummary = audit.summary ?? '';
          for (const item of audit.flagged) {
            if (!recipeMap.has(item.recipeId)) continue;
            if (!flaggedReasons.has(item.recipeId)) {
              flaggedReasons.set(item.recipeId, item.reason);
            }
          }
        } catch (error) {
          if (abortSignal?.aborted) throw error;
          logger.warn(`Semantic allergy audit fallback used: ${String(error)}`);
        }
      }

      const flaggedDishes: FlaggedDishReport[] = [];
      for (const slot of slots) {
        for (const recipeId of slot.recipeIds) {
          const reason = flaggedReasons.get(recipeId);
          if (!reason) continue;
          const title = recipeMap.get(recipeId)?.title ?? recipeId;
          flaggedDishes.push({
            day: slot.day,
            section: slot.section,
            recipeId,
            title,
            reason,
          });
        }
      }

      if (flaggedDishes.length === 0) {
        return {
          verified: true,
          safe: true,
          checkedDishesCount: uniqueIds.length,
          flaggedDishes: [],
          summary:
            subagentSummary ||
            `Đã kiểm định ${uniqueIds.length} món theo hồ sơ dị ứng: tất cả đều an toàn.`,
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

        const vacatedKeys = new Set<string>();
        const affectedDays = new Set<Weekday>();
        const affectedSections = new Set<MealSection>();
        for (const slot of slots) {
          const hasFlag = slot.recipeIds.some((id) => flaggedReasons.has(id));
          if (!hasFlag) continue;
          const remainingCount = slot.recipeIds.filter(
            (id) => !flaggedReasons.has(id),
          ).length;
          if (remainingCount === 0) {
            vacatedKeys.add(`${slot.day}:${slot.section}`);
            affectedDays.add(slot.day);
            affectedSections.add(slot.section);
          }
        }

        if (vacatedKeys.size > 0) {
          const pinned = [...affectedDays].flatMap((day) =>
            [...affectedSections]
              .filter((section) => !vacatedKeys.has(`${day}:${section}`))
              .map((section) => ({ day, section })),
          );
          const refill = await mealPlan.fillPlan(userId, {
            weekStart: week,
            days: [...affectedDays],
            sections: [...affectedSections],
            onlyEmpty: true,
            avoidIds: [...flaggedReasons.keys()],
            pinned,
          });
          change = mergeChanges(change, refill);
        }
      }

      return {
        verified: true,
        safe: change !== undefined && change.applied,
        checkedDishesCount: uniqueIds.length,
        flaggedDishes,
        summary:
          subagentSummary ||
          `Phát hiện ${flaggedDishes.length} lượt món có nguy cơ dị ứng (${flaggedDishes.map((d) => `${d.title} - ${DAY_NAMES[d.day]} ${SECTION_NAMES[d.section]}`).join('; ')})${change?.applied ? ' và đã tự động đổi sang món an toàn.' : '.'}`,
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
      const flaggedLines =
        output.flaggedDishes.length > 0
          ? `\nFlagged:\n${output.flaggedDishes.map((item) => `- ${DAY_NAMES[item.day]} ${SECTION_NAMES[item.section]}: ${item.title} — ${item.reason}`).join('\n')}`
          : '';
      const changeNote = formatChangeNote(output);
      return {
        type: 'text',
        value: `${output.summary}${flaggedLines}${changeNote}`,
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
