import { MealSection, Weekday } from '../mongo/models.js';
import { MAX_DISHES_PER_SECTION } from './dto/meal-plan.dto.js';
import type { SlotRecipeIds } from './meal-plan-generator.js';

export type SlotKey = { day: Weekday; section: MealSection };

export type DraftOp =
  | ({ op: 'set'; recipeIds: string[] } & SlotKey)
  | ({ op: 'add'; recipeId: string } & SlotKey)
  | ({ op: 'remove'; recipeId: string } & SlotKey)
  | ({ op: 'clear' } & SlotKey)
  | { op: 'move'; from: SlotKey; to: SlotKey; recipeId: string };

export type WeekIds = Map<Weekday, SlotRecipeIds>;

export function emptyWeekIds(days: readonly Weekday[]): WeekIds {
  const week: WeekIds = new Map();
  for (const day of days) {
    week.set(day, { BREAKFAST: [], LUNCH: [], DINNER: [], OTHER: [] });
  }
  return week;
}

export function cloneWeekIds(week: WeekIds): WeekIds {
  const copy: WeekIds = new Map();
  for (const [day, slots] of week) {
    copy.set(day, {
      BREAKFAST: [...slots.BREAKFAST],
      LUNCH: [...slots.LUNCH],
      DINNER: [...slots.DINNER],
      OTHER: [...slots.OTHER],
    });
  }
  return copy;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Slots whose dishes differ between two weeks, in week order. */
export function changedSlots(
  next: WeekIds,
  base: WeekIds,
  sections: readonly MealSection[],
): (SlotKey & { recipeIds: string[] })[] {
  const changed: (SlotKey & { recipeIds: string[] })[] = [];
  for (const [day, slots] of next) {
    const baseSlots = base.get(day);
    for (const section of sections) {
      const before = baseSlots?.[section] ?? [];
      if (sameList(slots[section], before)) continue;
      changed.push({ day, section, recipeIds: [...slots[section]] });
    }
  }
  return changed;
}

const label = ({ day, section }: SlotKey) => `${day} ${section}`;

/**
 * Applies the operations in order to a copy of `week`. Every operation that
 * cannot be applied is reported and skipped; the rest still take effect.
 */
export function applyDraftOps(
  week: WeekIds,
  ops: readonly DraftOp[],
): { week: WeekIds; errors: string[] } {
  const next = cloneWeekIds(week);
  const errors: string[] = [];

  const slotOf = (key: SlotKey): string[] | null => {
    const day = next.get(key.day);
    if (!day) return null;
    return day[key.section];
  };

  for (const op of ops) {
    if (op.op === 'move') {
      const from = slotOf(op.from);
      const to = slotOf(op.to);
      if (!from || !to) {
        errors.push(`move: unknown slot`);
        continue;
      }
      if (!from.includes(op.recipeId)) {
        errors.push(`move: ${op.recipeId} is not in ${label(op.from)}`);
        continue;
      }
      if (to.length >= MAX_DISHES_PER_SECTION && !to.includes(op.recipeId)) {
        errors.push(`move: ${label(op.to)} is full`);
        continue;
      }
      from.splice(from.indexOf(op.recipeId), 1);
      if (!to.includes(op.recipeId)) to.push(op.recipeId);
      continue;
    }

    const slot = slotOf(op);
    if (!slot) {
      errors.push(`${op.op}: unknown slot`);
      continue;
    }
    switch (op.op) {
      case 'set': {
        const unique = [...new Set(op.recipeIds)];
        if (unique.length > MAX_DISHES_PER_SECTION) {
          errors.push(
            `set: ${label(op)} takes at most ${MAX_DISHES_PER_SECTION} dishes`,
          );
          break;
        }
        slot.splice(0, slot.length, ...unique);
        break;
      }
      case 'add':
        if (slot.includes(op.recipeId)) break;
        if (slot.length >= MAX_DISHES_PER_SECTION) {
          errors.push(`add: ${label(op)} is full`);
          break;
        }
        slot.push(op.recipeId);
        break;
      case 'remove':
        if (!slot.includes(op.recipeId)) {
          errors.push(`remove: ${op.recipeId} is not in ${label(op)}`);
          break;
        }
        slot.splice(slot.indexOf(op.recipeId), 1);
        break;
      case 'clear':
        slot.splice(0, slot.length);
        break;
    }
  }
  return { week: next, errors };
}
