/**
 * Equality on a field whose index is partial on `{ $type: 'string' }`.
 *
 * MongoDB only uses a partial index when the query implies its filter, and a
 * plain `{ field: value }` does not imply `$type: 'string'`, so such lookups
 * fall back to a collection scan. Adding `$type` lets the planner pick the
 * index; the match itself is unchanged because `value` is a string.
 */
export function presentString(value: string): {
  $eq: string;
  $type: 'string';
} {
  return { $eq: value, $type: 'string' };
}
