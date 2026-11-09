export interface ConflictRule {
  id: string;
  aIngredientId: string | null;
  aGroupId: string | null;
  bIngredientId: string | null;
  bGroupId: string | null;
  reason: string;
  source: string | null;
}

export interface IngredientConflict {
  ruleId: string;
  ingredientAId: string;
  ingredientBId: string;
  reason: string;
  source: string | null;
}

export function detectConflicts(
  ingredientIds: readonly string[],
  groupsByIngredient: ReadonlyMap<string, ReadonlySet<string>>,
  rules: readonly ConflictRule[],
): IngredientConflict[] {
  const matching = (ingredientId: string | null, groupId: string | null) =>
    ingredientIds.filter(
      (id) =>
        id === ingredientId ||
        (groupId !== null && groupsByIngredient.get(id)?.has(groupId)),
    );

  const conflicts: IngredientConflict[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const sideA = matching(rule.aIngredientId, rule.aGroupId);
    const sideB = matching(rule.bIngredientId, rule.bGroupId);
    for (const a of sideA) {
      for (const b of sideB) {
        if (a === b) continue;
        const key = `${rule.id}:${[a, b].sort().join(':')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push({
          ruleId: rule.id,
          ingredientAId: a,
          ingredientBId: b,
          reason: rule.reason,
          source: rule.source,
        });
      }
    }
  }
  return conflicts;
}
