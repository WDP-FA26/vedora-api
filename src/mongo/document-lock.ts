import type { ClientSession, Db } from 'mongodb';

export type LockKind =
  'user' | 'recipe' | 'post' | 'account-gate' | 'payer' | 'transaction';

/**
 * Serializes transactions that touch the same document. MongoDB has no row
 * locks, so each one writes a lock document: two transactions writing the
 * same document conflict, and `session.withTransaction` retries the later
 * one instead of letting them interleave. Take locks in a fixed order, and
 * release them by ending the transaction.
 */
export async function lockDocument(
  database: Db,
  session: ClientSession,
  kind: LockKind,
  id = '',
): Promise<void> {
  const key = id ? `${kind}:${id}` : kind;
  await database
    .collection<{ _id: string; version: number }>('document_locks')
    .updateOne(
      { _id: key },
      { $inc: { version: 1 } },
      { upsert: true, session },
    );
}
