import { type ConflictRule, detectConflicts } from './conflicts';

const tofu = 'tofu';
const honey = 'honey';
const spinach = 'spinach';
const kale = 'kale';
const greens = 'group-greens';
const calcium = 'group-calcium';

const rule = (overrides: Partial<ConflictRule>): ConflictRule => ({
  id: 'rule-1',
  aIngredientId: null,
  aGroupId: null,
  bIngredientId: null,
  bGroupId: null,
  reason: 'Không nên ăn cùng',
  source: null,
  ...overrides,
});

const groups = new Map([
  [spinach, new Set([greens])],
  [kale, new Set([greens])],
  [tofu, new Set([calcium])],
]);

describe('detectConflicts', () => {
  it('matches an ingredient pair whichever side each is on', () => {
    const rules = [rule({ aIngredientId: honey, bIngredientId: tofu })];
    expect(detectConflicts([tofu, honey], new Map(), rules)).toEqual([
      expect.objectContaining({
        ruleId: 'rule-1',
        ingredientAId: honey,
        ingredientBId: tofu,
      }),
    ]);
    expect(detectConflicts([tofu], new Map(), rules)).toEqual([]);
  });

  it('matches every member of a group', () => {
    const rules = [rule({ aGroupId: greens, bGroupId: calcium })];
    const conflicts = detectConflicts(
      [spinach, kale, tofu, honey],
      groups,
      rules,
    );
    expect(conflicts.map((c) => [c.ingredientAId, c.ingredientBId])).toEqual([
      [spinach, tofu],
      [kale, tofu],
    ]);
  });

  it('pairs the members of a group that conflicts with itself once', () => {
    const rules = [rule({ aGroupId: greens, bGroupId: greens })];
    expect(detectConflicts([spinach, kale], groups, rules)).toHaveLength(1);
    expect(detectConflicts([spinach], groups, rules)).toEqual([]);
  });

  it('never reports an ingredient against itself', () => {
    const both = new Map([[tofu, new Set([greens, calcium])]]);
    const rules = [rule({ aGroupId: greens, bGroupId: calcium })];
    expect(detectConflicts([tofu], both, rules)).toEqual([]);
  });
});
