import type { SchemaOptions } from '@nestjs/mongoose';
import type { ClientSession, Connection, Schema } from 'mongoose';
import type { MongoModelName } from './model-definitions.js';

type Timestamps = 'both' | 'created' | 'updated' | 'none';

const TIMESTAMPS: Record<Timestamps, SchemaOptions['timestamps']> = {
  both: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  created: { createdAt: 'createdAt', updatedAt: false },
  updated: { createdAt: false, updatedAt: 'updatedAt' },
  none: false,
};

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

export type CascadeAction = 'delete' | 'unset' | 'pull';

export interface CascadeLink {
  readonly model: MongoModelName;
  readonly field: string;
  readonly action: CascadeAction;
}

export function cascadeOnDelete<T extends { _id: string }>(
  schema: Schema<T>,
  links: readonly CascadeLink[],
): void {
  onDelete(schema, async (db, ids, session) => {
    for (const link of links) {
      await applyCascadeLink(db, link, ids, session);
    }
  });
}

async function applyCascadeLink(
  db: Connection,
  link: CascadeLink,
  ids: string[],
  session: ClientSession | undefined,
): Promise<void> {
  const inIds = { $in: ids };
  const matching = { [link.field]: inIds };
  switch (link.action) {
    case 'delete':
      await db.model(link.model).deleteMany(matching, { session }).exec();
      break;
    case 'unset':
      await db
        .model(link.model)
        .updateMany(
          matching,
          { $set: { [link.field]: null } },
          { session, timestamps: false },
        )
        .exec();
      break;
    case 'pull':
      await db
        .model(link.model)
        .updateMany(
          matching,
          { $pull: { [link.field]: inIds } },
          { session, timestamps: false },
        )
        .exec();
      break;
  }
}
