import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession, Connection } from 'mongoose';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';

/**
 * The Mongoose connection shared by every model: starts snapshot transactions.
 *
 * Pass `{ session }` (or `.session(session)`) to every model operation inside
 * `withTransaction`, and do side effects (mail, events) after it returns.
 * `session.withTransaction` retries the callback on a write conflict, so the
 * callback must be safe to repeat.
 */
@Injectable()
export class MongoService {
  constructor(@InjectConnection() readonly connection: Connection) {}

  async ping(): Promise<void> {
    const database = this.connection.db;
    if (!database) {
      throw new FeatureUnavailableException(
        'SERVICE_UNAVAILABLE',
        'MongoDB connection is not ready',
      );
    }
    await database.admin().command({ ping: 1 });
  }

  async withTransaction<T>(
    run: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    try {
      // Every read in the transaction sees one snapshot of the data.
      return await session.withTransaction(() => run(session), {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
    } finally {
      await session.endSession();
    }
  }
}
