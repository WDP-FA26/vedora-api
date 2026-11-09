import type { QueryFilter } from 'mongoose';

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
