import { runtimeConfig } from '../config/runtime-config.js';
import { loadTextConfig } from '../config/config-files.js';
import type {
  DietaryRestrictionsDto,
  NutritionProfileDto,
} from '../recipes/dto/dietary.dto.js';
import type { MealPlanDto } from './dto/meal-plan.dto.js';
import { addDays } from './meal-week.js';
import {
  BmiCategory,
  NutritionGoal,
  NutritionPillar,
  Weekday,
} from '../mongo/models.js';

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

const WEEKDAYS: readonly Weekday[] = Object.values(Weekday);

const WEB_SEARCH_ASK = `Tìm trên web: người dùng chưa cho phép bạn tự tìm trên web. Chuyên gia dinh dưỡng chạy ngầm vẫn tra được web cho món ngoài hệ thống, đồ đóng gói hay kiến thức chưa có trong tài liệu nội bộ; chỉ xin phép tìm web trực tiếp khi người dùng cần xem nguồn.`;

const WEB_SEARCH_ALLOWED = `Tìm trên web: người dùng đã cho phép bạn tìm trên web. Dùng nó cho món ngoài hệ thống, đồ đóng gói, mùa vụ hay kiến thức chưa có trong tài liệu nội bộ.`;

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

const BMI_LABELS: Record<BmiCategory, string> = {
  [BmiCategory.UNDERWEIGHT]: 'cần bồi bổ (< 18,5)',
  [BmiCategory.NORMAL]: 'cân đối (18,5–22,9)',
  [BmiCategory.OVERWEIGHT]: 'hơi dư năng lượng (23,0–24,9)',
  [BmiCategory.OBESE]: 'cần kiểm soát cân nặng (>= 25,0)',
};

const GOAL_LABELS: Record<NutritionGoal, string> = {
  [NutritionGoal.LOSE_WEIGHT]: 'Giảm cân nhẹ nhàng',
  [NutritionGoal.MAINTAIN]: 'Giữ dáng & cân bằng dinh dưỡng',
  [NutritionGoal.GAIN_WEIGHT]: 'Tăng cân lành mạnh',
};

const PILLAR_SHORT_LABELS: Record<NutritionPillar, string> = {
  [NutritionPillar.PLANT_PROTEIN]: 'Đạm TV',
  [NutritionPillar.FIBER_VEG]: 'Xơ',
  [NutritionPillar.HEALTHY_FAT]: 'Béo tốt',
  [NutritionPillar.IRON_RICH]: 'Sắt',
  [NutritionPillar.CALCIUM_RICH]: 'Canxi',
};

function nutritionSummary(
  nutrition: NutritionProfileDto | null | undefined,
): string {
  if (!nutrition || nutrition.bmi === null) {
    return 'Hồ sơ BMI & mục tiêu năng lượng: người dùng chưa khai báo chiều cao/cân nặng (vẫn tư vấn cân bằng 5 nhóm chất chay và gợi ý khéo léo nếu phù hợp).';
  }
  const category = nutrition.bmiCategory
    ? BMI_LABELS[nutrition.bmiCategory]
    : '';
  const goal = nutrition.effectiveGoal
    ? GOAL_LABELS[nutrition.effectiveGoal]
    : '';
  const lines = [
    `Hồ sơ cơ thể & Mục tiêu dinh dưỡng (chuẩn BMI Châu Á):`,
    `- Chiều cao ${nutrition.heightCm} cm, cân nặng ${nutrition.weightKg} kg, BMI ~${nutrition.bmi} (${category}).`,
  ];
  if (nutrition.targetWeightKg !== null) {
    lines.push(`- Cân nặng hướng tới: ${nutrition.targetWeightKg} kg.`);
  }
  if (goal && nutrition.dailyCalorieTarget !== null) {
    lines.push(
      `- Mục tiêu: ${goal}. Nhu cầu tham khảo ~${nutrition.dailyCalorieTarget} kcal/ngày (vùng linh hoạt ${nutrition.dailyCalorieMin}–${nutrition.dailyCalorieMax} kcal).`,
    );
  }
  if (nutrition.history.length >= 2) {
    const oldest = nutrition.history[0];
    const newest = nutrition.history[nutrition.history.length - 1];
    const delta = Math.round((newest.weightKg - oldest.weightKg) * 10) / 10;
    const trend =
      delta === 0
        ? 'ổn định'
        : delta > 0
          ? `tăng ${delta} kg`
          : `giảm ${Math.abs(delta)} kg`;
    const feelingNote = newest.feeling
      ? `, cảm nhận gần nhất: ${newest.feeling.toLowerCase()}`
      : '';
    lines.push(
      `- Theo dõi cân nặng gần đây (${oldest.date} → ${newest.date}): ${trend}${feelingNote}.`,
    );
  }
  if (nutrition.safetyNote) {
    lines.push(`- Lưu ý an toàn: ${nutrition.safetyNote}`);
  }
  return lines.join('\n');
}

function stripPlannerContextTags(text: string): string {
  return text.replace(/<\/?(?:planner_context|system-reminder)\b[^>]*>?/gi, '');
}

/**
 * Static planner rules and web-search capability note, safe to cache across
 * users and turns.
 */
export function plannerStaticInstructions(allowWebSearch = false): string {
  const webSearch = allowWebSearch ? WEB_SEARCH_ALLOWED : WEB_SEARCH_ASK;
  return `${RULES}\n\n${webSearch}`;
}

/**
 * Per-user and per-week dynamic context placed in the latest user turn so
 * the static system prefix remains cacheable.
 */
export function plannerDynamicContext(
  restrictions: DietaryRestrictionsDto,
  plan: MealPlanDto,
  nutrition?: NutritionProfileDto | null,
): string {
  const avoided = [
    ...restrictions.groups.map(({ name }) => `nhóm ${name}`),
    ...restrictions.ingredients.map(({ name }) => name),
  ];
  const days = plan.days.map(({ day, sections }) => {
    const dayPillars = new Set<NutritionPillar>();
    let dayCalories = 0;
    let hasCalories = false;
    const filled = sections
      .filter(({ recipes }) => recipes.length > 0)
      .map(({ section, recipes }) => {
        for (const recipe of recipes) {
          if (typeof recipe.caloriesPerServing === 'number') {
            dayCalories += recipe.caloriesPerServing;
            hasCalories = true;
          }
          for (const pillar of recipe.nutritionPillars ?? []) {
            dayPillars.add(pillar);
          }
        }
        return `${SECTION_NAMES[section]}: ${recipes
          .map(({ title, id, caloriesPerServing }) =>
            typeof caloriesPerServing === 'number'
              ? `${title} (id ${id}, ~${caloriesPerServing} kcal)`
              : `${title} (id ${id})`,
          )
          .join(', ')}`;
      });
    const nutritionNote = hasCalories
      ? ` — ước tính ~${dayCalories} kcal${dayPillars.size > 0 ? ` (${[...dayPillars].map((item) => PILLAR_SHORT_LABELS[item]).join(', ')})` : ''}`
      : '';
    return `- ${DAY_NAMES[day]}: ${filled.length > 0 ? filled.join('; ') : '(trống)'}${nutritionNote}`;
  });
  const allergyNote = restrictions.allergyNote?.trim()
    ? stripPlannerContextTags(restrictions.allergyNote.trim())
    : 'chưa mô tả thêm';
  const preferenceNote = restrictions.preferenceNote?.trim()
    ? stripPlannerContextTags(restrictions.preferenceNote.trim())
    : 'chưa có';

  return `${plannerCalendar(plan)}

${nutritionSummary(nutrition)}

Thực phẩm người dùng không ăn (searchRecipes và getRecipe vẫn trả món chứa chúng, đánh dấu AVOIDED): ${
    avoided.length > 0 ? avoided.join(', ') : 'chưa khai báo gì'
  }.
Mô tả dị ứng & lưu ý ăn uống của người dùng (mục Dị ứng trong Hồ sơ ăn uống, bạn bổ sung bằng updateAllergyNote): ${allergyNote}.
Sở thích và thói quen người dùng (mục "Sở thích" trong Hồ sơ ăn uống, bạn cập nhật bằng updatePreferences; tôn trọng khi lên món): ${preferenceNote}.

Thực đơn hiện tại của tuần người dùng đang xem (weekStart ${plan.weekStart}, gọi getPlan để xem tuần khác):
${days.join('\n')}`;
}

export function plannerInstructions(
  restrictions: DietaryRestrictionsDto,
  plan: MealPlanDto,
  allowWebSearch = false,
  nutrition?: NutritionProfileDto | null,
): string {
  return `${plannerStaticInstructions(allowWebSearch)}\n\n${plannerDynamicContext(
    restrictions,
    plan,
    nutrition,
  )}`;
}
