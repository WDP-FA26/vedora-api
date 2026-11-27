import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

@Schema(collectionSchema('allergy_verdicts', 'updated'))
export class AllergyVerdict extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: String, required: true })
  recipeId!: string;

  @Prop({ type: String, required: true })
  profileHash!: string;

  @Prop({ type: String, required: true })
  recipeVersion!: string;

  @Prop({ type: String, default: null })
  reason!: string | null;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const AllergyVerdictSchema =
  SchemaFactory.createForClass(AllergyVerdict);
AllergyVerdictSchema.index({ userId: 1, recipeId: 1 }, { unique: true });
