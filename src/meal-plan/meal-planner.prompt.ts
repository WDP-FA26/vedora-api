import { runtimeConfig } from '../config/runtime-config.js';
import { loadTextConfig } from '../config/config-files.js';
import type { DietaryRestrictionsDto } from '../recipes/dto/dietary.dto.js';
import type { MealPlanDto } from './dto/meal-plan.dto.js';
import type { DraftProposal } from './meal-plan.service.js';
import { addDays } from './meal-week.js';
import { Weekday } from '../mongo/models.js';

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

const WEEKDAYS: readonly Weekday[] = Object.values(Weekday);

/** `2026-11-19` as `19/11`. */
function dayMonth(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

function weekLabel(weekStart: string, currentWeekStart: string): string {
  if (weekStart === currentWeekStart) return 'Tuần này';
  if (weekStart === addDays(currentWeekStart, 7)) return 'Tuần sau';
  return 'Tuần';
}

/**
 * Every week the planner may write to, with real dates, so the model turns
 * "T4", "tuần sau" or "25/11" into one day without guessing.
 */
export function plannerCalendar(plan: MealPlanDto): string {
  const { today, currentWeekStart, maxWeekStart, weekStart } = plan;
  const todayIndex = WEEKDAYS.findIndex(
    (_, index) => addDays(currentWeekStart, index) === today,
  );
  const todayName =
    todayIndex >= 0 ? `${DAY_NAMES[WEEKDAYS[todayIndex]]} ` : '';
  const lines: string[] = [];
  for (
    let start = currentWeekStart;
    start <= maxWeekStart;
    start = addDays(start, 7)
  ) {
    const end = addDays(start, 6);
    const open = start === weekStart ? ' — người dùng đang xem tuần này' : '';
    let status = 'mọi ngày còn sửa được';
    if (start === currentWeekStart && todayIndex > 0) {
      const passed = WEEKDAYS.slice(0, todayIndex)
        .map(
          (day, index) =>
            `${DAY_NAMES[day]} ${dayMonth(addDays(start, index))}`,
        )
        .join(', ');
      status = `đã qua, không sửa được: ${passed}; còn sửa được từ hôm nay`;
    }
    lines.push(
      `- ${weekLabel(start, currentWeekStart)} ${dayMonth(start)}–${dayMonth(end)} (weekStart ${start}): ${status}${open}`,
    );
  }
  if (weekStart < currentWeekStart) {
    lines.unshift(
      `- Tuần ${dayMonth(weekStart)}–${dayMonth(addDays(weekStart, 6))} (weekStart ${weekStart}): đã qua hết, chỉ để xem — người dùng đang xem tuần này`,
    );
  }
  const lastDay = addDays(maxWeekStart, 6);
  return `Hôm nay là ${todayName}${today}.
Lịch các tuần bạn được lập:
${lines.join('\n')}
Sau ${lastDay} là ngoài giới hạn, không lập được.`;
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

${plannerCalendar(plan)}

Thực phẩm người dùng không ăn (searchRecipes đã loại sẵn các món chứa chúng): ${
    avoided.length > 0 ? avoided.join(', ') : 'chưa khai báo gì'
  }.
Nguyên liệu người dùng thích: ${
    restrictions.liked.length > 0
      ? restrictions.liked.map(({ name }) => name).join(', ')
      : 'chưa khai báo gì'
  }.

Thực đơn đang lưu của tuần người dùng đang xem (weekStart ${plan.weekStart}, gọi getPlan để xem tuần khác):
${days.join('\n')}${draftSummary(draft)}`;
}
