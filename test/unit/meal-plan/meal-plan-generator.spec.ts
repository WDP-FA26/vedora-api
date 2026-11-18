import { describe, expect, it } from 'vitest';
import { MealSection, RecipeTag, Weekday } from '../../../src/mongo/models.js';
import {
  generateMealDays,
  type GeneratorCandidate,
  type SlotRecipeIds,
} from '../../../src/meal-plan/meal-plan-generator.js';

function candidate(id: string, tag: RecipeTag): GeneratorCandidate {
  return {
    id,
    title: id,
    tag,
    minutes: 30,
    ingredientIds: [],
    likedCount: 0,
    matchesQuery: false,
  };
}

function slots(breakfast: string[], lunch: string[] = []): SlotRecipeIds {
  return { BREAKFAST: breakfast, LUNCH: lunch, DINNER: [], OTHER: [] };
}

const allCompatible = (sets: string[][]) =>
  Promise.resolve(sets.map(() => true));

describe('generateMealDays', () => {
  it('gives every replaced slot a different dish when another one fits', async () => {
    const days = [Weekday.THU, Weekday.FRI, Weekday.SAT, Weekday.SUN];
    const saved = new Map<Weekday, SlotRecipeIds>([
      [Weekday.THU, slots(['soup-1'])],
      [Weekday.FRI, slots(['soup-2'])],
      [Weekday.SAT, slots(['soup-3'])],
      [Weekday.SUN, slots(['soup-4'])],
    ]);
    // Eight breakfast dishes: four free ones are already eaten at Monday's
    // lunch, so the dish being replaced is the least used one in the week.
    const candidates = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
      candidate(`soup-${n}`, RecipeTag.SOUP),
    );
    const usedElsewhere = new Map(saved);
    usedElsewhere.set(
      Weekday.MON,
      slots([], ['soup-5', 'soup-6', 'soup-7', 'soup-8']),
    );

    for (let run = 0; run < 50; run += 1) {
      const generated = await generateMealDays({
        candidates,
        saved: usedElsewhere,
        days,
        sections: [MealSection.BREAKFAST],
        skip: [],
        onlyEmpty: false,
        perSection: 1,
        ignoreFit: false,
        areCompatible: allCompatible,
        random: Math.random,
      });

      expect(generated.map(({ day }) => day)).toEqual(days);
      for (const { day, BREAKFAST } of generated) {
        expect(BREAKFAST).not.toEqual(saved.get(day)?.BREAKFAST);
      }
    }
  });

  it('keeps the old dish when it is the only one that fits', async () => {
    const generated = await generateMealDays({
      candidates: [candidate('soup-1', RecipeTag.SOUP)],
      saved: new Map([[Weekday.THU, slots(['soup-1'])]]),
      days: [Weekday.THU],
      sections: [MealSection.BREAKFAST],
      skip: [],
      onlyEmpty: false,
      perSection: 1,
      ignoreFit: false,
      areCompatible: allCompatible,
      random: () => 0,
    });

    // Unchanged days are not returned, so the saved dish stays in place.
    expect(generated).toEqual([]);
  });
});
