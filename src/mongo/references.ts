import type { Model } from 'mongoose';

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
