import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { CalorieSource, MealLogSource, MealSection } from '../enums.js';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

@Schema({ _id: false, versionKey: false })
export class CalorieReference {
  @Prop({ type: String, required: true })
  title!: string;

  @Prop({ type: String, required: true })
  url!: string;
}

export const CalorieReferenceSchema =
  SchemaFactory.createForClass(CalorieReference);

/**
 * One dish the user ate. Separate from the plan, which holds what they meant
 * to eat. Name and calories are copied when logged, so the history stays as it
 * was when a recipe changes or is deleted (`recipeId` then becomes null).
 */
@Schema(collectionSchema('meal_log_entries'))
export class MealLogEntry extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  /** Calendar date in the app time zone, `YYYY-MM-DD`. */
  @Prop({ type: String, required: true })
  date!: string;

  @Prop({ type: String, enum: Object.values(MealSection), required: true })
  section!: MealSection;

  @Prop({ type: String, enum: Object.values(MealLogSource), required: true })
  source!: MealLogSource;

  @Prop({ type: String, default: null })
  recipeId!: string | null;

  @Prop({ type: String, required: true })
  name!: string;

  @Prop({ type: Number, required: true, default: 1 })
  servings!: number;

  /** Unknown until the user types it or asks AI to estimate it. */
  @Prop({ type: Number, default: null })
  caloriesPerServing!: number | null;

  @Prop({ type: String, enum: Object.values(CalorieSource), default: null })
  calorieSource!: CalorieSource | null;

  @Prop({ type: String, default: null })
  calorieNote!: string | null;

  @Prop({ type: [CalorieReferenceSchema], required: true, default: [] })
  calorieReferences!: CalorieReference[];

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const MealLogEntrySchema = SchemaFactory.createForClass(MealLogEntry);
MealLogEntrySchema.index({ userId: 1, date: 1, section: 1, createdAt: 1 });
// A recipe is logged once per meal; eating more of it raises its servings.
MealLogEntrySchema.index(
  { userId: 1, date: 1, section: 1, recipeId: 1 },
  { unique: true, partialFilterExpression: { recipeId: { $type: 'string' } } },
);
MealLogEntrySchema.index({ recipeId: 1 });
