import type { SchemaOptions } from '@nestjs/mongoose';

type Timestamps = 'both' | 'created' | 'updated' | 'none';

const TIMESTAMPS: Record<Timestamps, SchemaOptions['timestamps']> = {
  both: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  created: { createdAt: 'createdAt', updatedAt: false },
  updated: { createdAt: false, updatedAt: 'updatedAt' },
  none: false,
};

/**
 * Options shared by every schema: the collection name it has always used,
 * the timestamps Prisma maintained, no `__v`, and `toObject()`/`toJSON()`
 * carrying the `id` string that services and DTOs read.
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
 * Index names Prisma generated for the same keys. Keeping them makes the
 * schema a no-op on databases that were created by `prisma db push`, instead
 * of MongoDB rejecting a second index with the same key.
 */
export function indexName(
  collection: string,
  fields: string[],
  kind: 'key' | 'idx',
) {
  return `${collection}_${fields.join('_')}_${kind}`;
}
