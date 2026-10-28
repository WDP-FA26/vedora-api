import type { SchemaOptions } from '@nestjs/mongoose';
import type { ClientSession, Connection, Schema } from 'mongoose';

type Timestamps = 'both' | 'created' | 'updated' | 'none';

const TIMESTAMPS: Record<Timestamps, SchemaOptions['timestamps']> = {
  both: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  created: { createdAt: 'createdAt', updatedAt: false },
  updated: { createdAt: false, updatedAt: 'updatedAt' },
  none: false,
};

/**
 * Options shared by every schema: collection name, timestamps, no `__v`, and
 * `toObject()`/`toJSON()` carrying the `id` string that services and DTOs read.
 */
export function collectionSchema(
  collection: string,
  timestamps: Timestamps = 'both',
): SchemaOptions {
  return {
    collection,
    timestamps: TIMESTAMPS[timestamps],
    versionKey: false,
    toObject: { virtuals: true },
    toJSON: { virtuals: true },
  };
}

/**
 * Runs `cleanup` with the connection, matching `_id`s and active session
 * before `deleteMany` or `deleteOne` removes documents from `schema`.
 */
export function onDelete<T extends { _id: string }>(
  schema: Schema<T>,
  cleanup: (
    db: Connection,
    ids: string[],
    session: ClientSession | undefined,
  ) => Promise<void>,
): void {
  for (const hook of ['deleteMany', 'deleteOne'] as const) {
    schema.pre(hook, { document: false, query: true }, async function () {
      const session = this.getOptions().session ?? undefined;
      const docs = await this.model.db
        .model<{ _id: string }>(this.model.modelName)
        .find(this.getFilter())
        .select('_id')
        .lean()
        .session(session ?? null)
        .exec();
      if (docs.length === 0) return;
      await cleanup(
        this.model.db,
        docs.map((doc) => doc._id),
        session,
      );
    });
  }
}
