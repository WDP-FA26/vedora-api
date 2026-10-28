import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession, Db } from 'mongodb';
import type { Connection } from 'mongoose';

/**
 * The database connection shared by every model: transactions, the driver
 * `Db` for the few pipelines models do not cover, and nothing else.
 *
 * MongoDB has no transactions on `Model` helpers, so start one here, pass
 * `{ session }` to every model operation inside it, and do side effects
 * (mail, events) after it returns. `session.withTransaction` retries the
 * callback on a write conflict, so the callback must be safe to repeat.
 */
@Injectable()
export class MongoService {
  constructor(@InjectConnection() readonly connection: Connection) {}

  get db(): Db {
    // Defined once `MongooseModule.forRoot` resolves, which it does before
    // any request or lifecycle hook runs.
    const database = this.connection.db;
    if (!database) throw new Error('MongoDB connection is not ready');
    return database;
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
