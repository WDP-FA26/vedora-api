import { runtimeConfig } from '../config/runtime-config.js';
import { loadTextConfig } from '../config/config-files.js';
import type { DietaryRestrictionsDto } from '../recipes/dto/dietary.dto.js';
import type { MealPlanDto } from './dto/meal-plan.dto.js';
import type { DraftProposal } from './meal-plan.service.js';

export const DAY_NAMES = {
  MON: 'Thứ Hai',
  TUE: 'Thứ Ba',
  WED: 'Thứ Tư',
  THU: 'Thứ Năm',
  FRI: 'Thứ Sáu',
  SAT: 'Thứ Bảy',
  SUN: 'Chủ nhật',
} as const;

export const SECTION_NAMES = {
  BREAKFAST: 'sáng',
  LUNCH: 'trưa',
  DINNER: 'tối',
  OTHER: 'khác',
} as const;

const RULES = loadTextConfig(runtimeConfig.PLANNER_SYSTEM_PROMPT_FILE);

function draftSummary(draft: DraftProposal | undefined): string {
  if (!draft || draft.days.length === 0) return '';
  const lines: string[] = [];
  for (const { day, sections } of draft.days) {
    const parts: string[] = [];
    for (const { section, recipes, previous } of sections) {
      const same =
        recipes.map(({ id }) => id).join() ===
        previous.map(({ id }) => id).join();
      if (same) continue;
      const now =
        recipes.length > 0
          ? recipes.map(({ title, id }) => `${title} (id ${id})`).join(', ')
          : '(trống)';
      parts.push(`${SECTION_NAMES[section]}: ${now}`);
    }
    if (parts.length > 0) {
      lines.push(`- ${DAY_NAMES[day]}: ${parts.join('; ')}`);
    }
  }
  if (lines.length === 0) return '';
  return `\n\nBản nháp đang đề xuất (chưa lưu):\n${lines.join('\n')}`;
}

export function plannerInstructions(
  restrictions: DietaryRestrictionsDto,
  plan: MealPlanDto,
  draft?: DraftProposal,
): string {
  const avoided = [
    ...restrictions.groups.map(({ name }) => `nhóm ${name}`),
    ...restrictions.ingredients.map(({ name }) => name),
  ];
  const days = plan.days.map(({ day, sections }) => {
    const filled = sections
      .filter(({ recipes }) => recipes.length > 0)
      .map(
        ({ section, recipes }) =>
          `${SECTION_NAMES[section]}: ${recipes
            .map(({ title, id }) => `${title} (id ${id})`)
            .join(', ')}`,
      );
    return `- ${DAY_NAMES[day]}: ${filled.length > 0 ? filled.join('; ') : '(trống)'}`;
  });
  return `${RULES}

Thực phẩm người dùng không ăn (searchRecipes đã loại sẵn các món chứa chúng): ${
    avoided.length > 0 ? avoided.join(', ') : 'chưa khai báo gì'
  }.
Nguyên liệu người dùng thích: ${
    restrictions.liked.length > 0
      ? restrictions.liked.map(({ name }) => name).join(', ')
      : 'chưa khai báo gì'
  }.

Thực đơn đang lưu:
${days.join('\n')}${draftSummary(draft)}`;
}
