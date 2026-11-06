import type { ClientSession } from 'mongoose';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { lockDocument } from './document-lock.js';
import { isUniqueViolation } from './errors.js';
import type { MongoService } from './mongo.service.js';

/** Same account locks as suspension/deletion, always taken in a stable order. */
export async function withUserLocks<T>(
  mongo: MongoService,
  userIds: string[],
  run: (session: ClientSession) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await mongo.withTransaction(async (session) => {
        for (const id of [...new Set(userIds)].sort()) {
          await lockDocument(mongo, session, 'user', id);
        }
        return run(session);
      });
    } catch (error) {
      // A lock's first concurrent upsert can report E11000 without the
      // transient-transaction label. Retry the entire, aborted transaction.
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new StateConflictException(
    'CONFLICT',
    'Concurrent change; retry the request',
  );
}
