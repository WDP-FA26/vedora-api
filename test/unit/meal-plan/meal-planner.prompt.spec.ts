import { MODERATION_VERDICTS } from '../../../src/ai/guardrails/guardrail.js';
import type { MealPlanDto } from '../../../src/meal-plan/dto/meal-plan.dto.js';
import {
  DAY_NAMES,
  plannerInstructions,
  SECTION_NAMES,
} from '../../../src/meal-plan/meal-planner.prompt.js';
import { PLANNER_REFUSALS } from '../../../src/meal-plan/meal-planner.refusals.js';
import { MealSection, Weekday } from '../../../src/mongo/models.js';
import type { DietaryRestrictionsDto } from '../../../src/recipes/dto/dietary.dto.js';

const emptyPlan = (): MealPlanDto => ({
  days: Object.values(Weekday).map((day) => ({
    day,
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
      liked: [],
    };

    const output = plannerInstructions(restrictions, emptyPlan());

    expect(output).toContain('Trợ lý Vedora');
    expect(output).toContain('chưa khai báo gì');
    expect(output).toContain('- Thứ Hai: (trống)');
    expect(output).toContain('- Chủ nhật: (trống)');
  });

  it('formats avoided groups, avoided ingredients, liked ingredients, and scheduled dishes', () => {
    const restrictions: DietaryRestrictionsDto = {
      ingredients: [{ id: 'ing-1', name: 'Hành' }],
      groups: [{ id: 'grp-1', name: 'Ngũ vị tân' }],
      liked: [{ id: 'ing-2', name: 'Đậu hũ' }],
    };
    const plan = emptyPlan();
    plan.days[0].sections[1].recipes.push({
      id: 'rec-1',
      title: 'Đậu hũ sốt cà',
      imageUrl: null,
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
      servings: 1,
      prepMinutes: 5,
      cookMinutes: null,
      ingredients: [],
      steps: ['Xay'],
    });

    const output = plannerInstructions(restrictions, plan);

    expect(output).toContain('nhóm Ngũ vị tân, Hành');
    expect(output).toContain('Nguyên liệu người dùng thích: Đậu hũ.');
    expect(output).toContain(
      `- ${DAY_NAMES.MON}: ${SECTION_NAMES.LUNCH}: Đậu hũ sốt cà (id rec-1); ${SECTION_NAMES.OTHER}: Sữa đậu nành (id rec-2)`,
    );
  });

  it('defines non-empty refusal messages for every non-allow moderation verdict', () => {
    const nonAllow = MODERATION_VERDICTS.filter(
      (verdict): verdict is Exclude<(typeof MODERATION_VERDICTS)[number], 'allow'> =>
        verdict !== 'allow',
    );
    for (const verdict of nonAllow) {
      expect(PLANNER_REFUSALS[verdict]).toBeTruthy();
      expect(typeof PLANNER_REFUSALS[verdict]).toBe('string');
    }
  });
});
