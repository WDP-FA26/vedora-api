import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession, Connection } from 'mongoose';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';

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
      return await session.withTransaction(() => run(session), {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
    } finally {
      await session.endSession();
    }
  }
}
