import type { ClientSession } from 'mongoose';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { lockDocument } from './document-lock.js';
import { isUniqueViolation } from './errors.js';
import type { MongoService } from './mongo.service.js';

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
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new StateConflictException(
    'CONFLICT',
    'Concurrent change; retry the request',
  );
}
