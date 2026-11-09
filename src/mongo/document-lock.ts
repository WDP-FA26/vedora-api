import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import { collectionSchema } from './schemas/common.js';
import { Identified } from './schemas/user.schema.js';

export type LockKind =
  'user' | 'recipe' | 'post' | 'account-gate' | 'payer' | 'transaction';

@Schema(collectionSchema('document_locks', 'none'))
export class DocumentLock extends Identified {
  @Prop({ type: String, required: true })
  _id!: string;

  @Prop({ type: Number, default: 0 })
  version!: number;
}

export const DocumentLockSchema = SchemaFactory.createForClass(DocumentLock);

export async function lockDocument(
  mongo: { readonly connection: Connection },
  session: ClientSession,
  kind: LockKind,
  id = '',
): Promise<void> {
  const key = id ? `${kind}:${id}` : kind;
  const locks =
    (mongo.connection.models[DocumentLock.name] as
      Model<DocumentLock> | undefined) ??
    mongo.connection.model<DocumentLock>(DocumentLock.name, DocumentLockSchema);
  await locks
    .updateOne(
      { _id: key },
      { $inc: { version: 1 } },
      { upsert: true, session },
    )
    .exec();
}
