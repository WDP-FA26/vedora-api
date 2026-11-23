import { MODERATION_VERDICTS } from '../../../src/ai/guardrails/guardrail.js';
import type { MealPlanDto } from '../../../src/meal-plan/dto/meal-plan.dto.js';
import {
  DAY_NAMES,
  plannerInstructions,
  SECTION_NAMES,
} from '../../../src/meal-plan/meal-planner.prompt.js';
import { PLANNER_REFUSALS } from '../../../src/meal-plan/meal-planner.refusals.js';
import {
  BmiCategory,
  MealSection,
  NutritionGoal,
  Weekday,
} from '../../../src/mongo/models.js';
import type {
  DietaryRestrictionsDto,
  NutritionProfileDto,
} from '../../../src/recipes/dto/dietary.dto.js';

// Wednesday 2026-11-18: Monday and Tuesday have passed.
const emptyPlan = (): MealPlanDto => ({
  weekStart: '2026-11-16',
  currentWeekStart: '2026-11-16',
  today: '2026-11-18',
  maxWeekStart: '2026-12-14',
  minWeekStart: '2026-11-16',
  editable: true,
  days: Object.values(Weekday).map((day, index) => ({
    day,
    date: `2026-11-${16 + index}`,
    editable: index >= 2,
    sections: Object.values(MealSection).map((section) => ({
      section,
      recipes: [],
    })),
  })),
  problems: [],
});

describe('meal-planner prompt & refusals', () => {
  it('renders fallback text when dietary profile and meal plan are empty', () => {
    const restrictions: DietaryRestrictionsDto = {
      ingredients: [],
      groups: [],
    };

    const output = plannerInstructions(restrictions, emptyPlan());

    expect(output).toContain('Trợ lý Vedora');
    expect(output).toContain('chưa khai báo gì');
    expect(output).toContain('- Thứ Hai: (trống)');
    expect(output).toContain('- Chủ nhật: (trống)');
  });

  it('lays out every plannable week with real dates and the passed days', () => {
    const restrictions: DietaryRestrictionsDto = {
      ingredients: [],
      groups: [],
    };

    const output = plannerInstructions(restrictions, emptyPlan());

    expect(output).toContain('Hôm nay là Thứ Tư 2026-11-18.');
    expect(output).toContain(
      '- Tuần này 16/11–22/11 (weekStart 2026-11-16): đã qua, không sửa được: Thứ Hai 16/11, Thứ Ba 17/11; còn sửa được từ hôm nay — người dùng đang xem tuần này',
    );
    expect(output).toContain(
      '- Tuần sau 23/11–29/11 (weekStart 2026-11-23): mọi ngày còn sửa được',
    );
    expect(output).toContain('- Tuần 14/12–20/12 (weekStart 2026-12-14)');
    expect(output).toContain('Sau 2026-12-20 là ngoài giới hạn');
    expect(output).toContain('tuần người dùng đang xem (weekStart 2026-11-16');
  });

  it('marks the week on screen when it is a later week', () => {
    const restrictions: DietaryRestrictionsDto = {
      ingredients: [],
      groups: [],
    };
    const output = plannerInstructions(restrictions, {
      ...emptyPlan(),
      weekStart: '2026-11-23',
    });

    expect(output).toContain(
      '(weekStart 2026-11-23): mọi ngày còn sửa được — người dùng đang xem tuần này',
    );
    expect(output).not.toContain(
      'còn sửa được từ hôm nay — người dùng đang xem tuần này',
    );
  });

  it('lists a past week on screen as read-only, before the plannable weeks', () => {
    const restrictions: DietaryRestrictionsDto = {
      ingredients: [],
      groups: [],
    };
    const plan = { ...emptyPlan(), weekStart: '2026-11-09', editable: false };

    const output = plannerInstructions(restrictions, plan);

    expect(output).toContain(
      'Lịch các tuần bạn được lập:\n- Tuần 09/11–15/11 (weekStart 2026-11-09): đã qua hết, chỉ để xem — người dùng đang xem tuần này',
    );
  });

  it('says nothing has passed on a Monday', () => {
    const restrictions: DietaryRestrictionsDto = {
      ingredients: [],
      groups: [],
    };
    const output = plannerInstructions(restrictions, {
      ...emptyPlan(),
      today: '2026-11-16',
    });

    expect(output).toContain('Hôm nay là Thứ Hai 2026-11-16.');
    expect(output).toContain(
      '- Tuần này 16/11–22/11 (weekStart 2026-11-16): mọi ngày còn sửa được',
    );
  });

  it('formats avoided groups, avoided ingredients, and scheduled dishes', () => {
    const restrictions: DietaryRestrictionsDto = {
      ingredients: [{ id: 'ing-1', name: 'Hành' }],
      groups: [{ id: 'grp-1', name: 'Ngũ vị tân' }],
    };
    const plan = emptyPlan();
    plan.days[0].sections[1].recipes.push({
      id: 'rec-1',
      title: 'Đậu hũ sốt cà',
      imageUrl: null,
      tag: null,
      servings: 2,
      prepMinutes: 10,
      cookMinutes: 10,
      ingredients: [],
      steps: ['Nấu'],
    });
    plan.days[0].sections[3].recipes.push({
      id: 'rec-2',
      title: 'Sữa đậu nành',
      imageUrl: null,
      tag: null,
      servings: 1,
      prepMinutes: 5,
      cookMinutes: null,
      ingredients: [],
      steps: ['Xay'],
    });

    const output = plannerInstructions(restrictions, plan);

    expect(output).toContain('nhóm Ngũ vị tân, Hành');
    expect(output).toContain(
      `- ${DAY_NAMES.MON}: ${SECTION_NAMES.LUNCH}: Đậu hũ sốt cà (id rec-1); ${SECTION_NAMES.OTHER}: Sữa đậu nành (id rec-2)`,
    );
  });

  it('defines non-empty refusal messages for every non-allow moderation verdict', () => {
    const nonAllow = MODERATION_VERDICTS.filter(
      (
        verdict,
      ): verdict is Exclude<(typeof MODERATION_VERDICTS)[number], 'allow'> =>
        verdict !== 'allow',
    );
    for (const verdict of nonAllow) {
      expect(PLANNER_REFUSALS[verdict]).toBeTruthy();
      expect(typeof PLANNER_REFUSALS[verdict]).toBe('string');
    }
  });

  it('includes Asian BMI profile, daily calorie range, and recent weight trend when provided', () => {
    const restrictions: DietaryRestrictionsDto = {
      ingredients: [],
      groups: [],
    };
    const nutrition: NutritionProfileDto = {
      heightCm: 160,
      weightKg: 62,
      targetWeightKg: 56,
      birthYear: 1998,
      biologicalSex: null,
      activityLevel: null,
      nutritionGoal: NutritionGoal.LOSE_WEIGHT,
      bmi: 24.2,
      bmiCategory: BmiCategory.OVERWEIGHT,
      suggestedGoal: NutritionGoal.LOSE_WEIGHT,
      effectiveGoal: NutritionGoal.LOSE_WEIGHT,
      idealWeightMinKg: 47.4,
      idealWeightMaxKg: 58.6,
      bmr: 1320,
      tdee: 1820,
      dailyCalorieTarget: 1470,
      dailyCalorieMin: 1250,
      dailyCalorieMax: 1690,
      safetyNote: null,
      history: [
        {
          id: 'log-1',
          date: '2026-11-01',
          weightKg: 63,
          heightCm: 160,
          bmi: 24.6,
          feeling: null,
          note: null,
          updatedAt: new Date(),
        },
        {
          id: 'log-2',
          date: '2026-11-18',
          weightKg: 62,
          heightCm: 160,
          bmi: 24.2,
          feeling: null,
          note: null,
          updatedAt: new Date(),
        },
      ],
    };

    const output = plannerInstructions(
      restrictions,
      emptyPlan(),
      false,
      nutrition,
    );

    expect(output).toContain('BMI ~24.2');
    expect(output).toContain('~1470 kcal/ngày');
    expect(output).toContain('giảm 1 kg');
  });
});
