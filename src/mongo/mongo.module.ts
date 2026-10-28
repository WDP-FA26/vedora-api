import { Global, Module, type DynamicModule } from '@nestjs/common';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { MongoService } from './mongo.service';
import { MODEL_DEFINITIONS } from './schemas';

/**
 * One connection and one model provider per collection, available app-wide.
 *
 * The models are registered here rather than with `MongooseModule.forFeature`
 * so this module can export exactly the tokens every feature injects.
 */
@Global()
@Module({})
export class MongoModule {
  static forRoot(): DynamicModule {
    return MongoModule.build(
      MongooseModule.forRootAsync({
        // Read at connection time, not module load: the e2e harness gives
        // every spec its own database by setting `DATABASE_URL` first. The
        // ConfigModule validation still guarantees its shape at startup.
        useFactory: () => ({
          uri: databaseUrl(),
          // Creates the indexes the schemas declare on startup.
          autoIndex: true,
        }),
      }),
    );
  }

  /** A connection of its own, for a test database. */
  static forTest(uri: string): DynamicModule {
    return MongoModule.build(MongooseModule.forRoot(uri, { autoIndex: true }));
  }

  private static build(connection: DynamicModule): DynamicModule {
    const models = MODEL_DEFINITIONS.map(({ name, schema }) => ({
      provide: getModelToken(name),
      inject: [getConnectionToken()],
      useFactory: (db: Connection): Model<unknown> =>
        (db.models[name] ?? db.model(name, schema)) as Model<unknown>,
    }));
    return {
      module: MongoModule,
      global: true,
      imports: [connection],
      providers: [MongoService, ...models],
      exports: [MongoService, ...models.map((m) => m.provide)],
    };
  }
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}
