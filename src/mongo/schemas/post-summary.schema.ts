import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { PostSummaryStatus, RecipeTag } from '../enums.js';
import { collectionSchema } from './common.js';
import { Identified } from './identified.js';

/**
 * One ingredient as the post states it. `name` is free text: matching it to a
 * catalog `Ingredient` is left to whoever turns the draft into a Recipe.
 */
@Schema({ _id: false })
export class SummaryIngredient {
  @Prop({ type: String, required: true })
  name!: string;

  @Prop({ type: Number, default: null })
  quantity!: number | null;

  @Prop({ type: String, default: null })
  unit!: string | null;

  @Prop({ type: String, default: null })
  note!: string | null;
}

export const SummaryIngredientSchema =
  SchemaFactory.createForClass(SummaryIngredient);

/**
 * A recipe draft read from the post, shaped like `Recipe` so it can prefill
 * the recipe form. Fields the post does not state stay null, never guessed.
 */
@Schema({ _id: false })
export class SummaryRecipe {
  @Prop({ type: String, required: true })
  title!: string;

  @Prop({ type: String, default: null })
  description!: string | null;

  @Prop({
    type: String,
    enum: [...Object.values(RecipeTag), null],
    default: null,
  })
  tag!: RecipeTag | null;

  @Prop({ type: Number, default: null })
  servings!: number | null;

  @Prop({ type: Number, default: null })
  prepMinutes!: number | null;

  @Prop({ type: Number, default: null })
  cookMinutes!: number | null;

  @Prop({ type: [SummaryIngredientSchema], required: true, default: [] })
  ingredients!: SummaryIngredient[];

  @Prop({ type: [String], required: true, default: [] })
  steps!: string[];
}

export const SummaryRecipeSchema = SchemaFactory.createForClass(SummaryRecipe);

/**
 * The AI summary of one published post (its text plus video transcripts, or
 * a blog's title and content). The row is also the claim: its unique postId
 * makes sure a post is summarized, and commented on, at most once.
 */
@Schema(collectionSchema('post_summaries'))
export class PostSummary extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  postId!: string;

  @Prop({
    type: String,
    enum: Object.values(PostSummaryStatus),
    required: true,
    default: PostSummaryStatus.PENDING,
  })
  status!: PostSummaryStatus;

  @Prop({ type: Number, required: true, default: 0 })
  attempts!: number;

  @Prop({ type: Date, default: null })
  claimedAt!: Date | null;

  /** sha256 of the text that was summarized, to tell when an edit changed it. */
  @Prop({ type: String, default: null })
  sourceHash!: string | null;

  /** ISO 639-1 code of the language the summary is written in. */
  @Prop({ type: String, default: null })
  language!: string | null;

  @Prop({ type: String, default: null })
  summary!: string | null;

  @Prop({ type: SummaryRecipeSchema, default: null })
  recipe!: SummaryRecipe | null;

  @Prop({ type: String, default: null })
  model!: string | null;

  /** The Vedora AI comment that shows the summary; null when none was posted. */
  @Prop({ type: String, default: null })
  commentId!: string | null;

  @Prop({ type: String, default: null })
  error!: string | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const PostSummarySchema = SchemaFactory.createForClass(PostSummary);
PostSummarySchema.index({ postId: 1 }, { unique: true });
PostSummarySchema.index({ status: 1, claimedAt: 1, _id: 1 });
