import type { QueryFilter } from 'mongoose';

/**
 * Cursor pagination for a feed sorted by `field` descending, then `_id`
 * descending: the rows that come after `cursor`, the last row of the
 * previous page. MongoDB has no cursor in a plain find, so this is the
 * filter `field < value OR (field = value AND _id < cursor id)`.
 */
export function afterCursor<T>(
  field: string,
  cursor: { value: Date; id: string },
): QueryFilter<T> {
  return {
    $or: [
      { [field]: { $lt: cursor.value } },
      { [field]: cursor.value, _id: { $lt: cursor.id } },
    ],
  };
}
