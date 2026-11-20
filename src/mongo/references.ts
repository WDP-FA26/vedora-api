import type { ClientSession, Model } from 'mongoose';

export async function allExist<TRawDocType>(
  model: Model<TRawDocType>,
  ids: Iterable<string>,
  session?: ClientSession,
): Promise<boolean> {
  const uniqueIds = new Set<string>(ids);
  if (uniqueIds.size === 0) return true;
  const foundCount = await model.countDocuments(
    { _id: { $in: Array.from(uniqueIds) } },
    { session },
  );
  return foundCount === uniqueIds.size;
}
