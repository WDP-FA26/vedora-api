/**
 * MongoDB checks no foreign keys, so a write that names another document must
 * first confirm it exists. True when every distinct id (nulls are ignored)
 * is found by `count`, which gets the distinct ids.
 */
export async function allExist(
  ids: Iterable<string | null | undefined>,
  count: (ids: string[]) => Promise<number>,
): Promise<boolean> {
  const distinct = [...new Set([...ids].filter((id): id is string => !!id))];
  return distinct.length === 0 || (await count(distinct)) === distinct.length;
}
