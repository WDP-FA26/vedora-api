import type { Model } from 'mongoose';

/**
 * MongoDB checks no foreign keys, so a write that names another document must
 * first confirm it exists. True when every distinct id is in `model`; an empty
 * list is vacuously true. Ids must be real strings: callers with optional ids
 * decide what "absent" means before calling.
 */
export async function allExist<TRawDocType>(
  model: Model<TRawDocType>,
  ids: Iterable<string>,
): Promise<boolean> {
  const uniqueIds = new Set<string>(ids);
  if (uniqueIds.size === 0) return true;
  const foundCount = await model.countDocuments({
    _id: { $in: Array.from(uniqueIds) },
  });
  return foundCount === uniqueIds.size;
}
