import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { MealSection, Weekday } from '../enums.js';
import { collectionSchema, onDelete } from './common.js';
import { Identified } from './user.schema.js';

@Schema(collectionSchema('ingredients'))
export class Ingredient extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  name!: string;

  @Prop({ type: [String], required: true, default: [] })
  aliases!: string[];

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const IngredientSchema = SchemaFactory.createForClass(Ingredient);
IngredientSchema.index({ name: 1 }, { unique: true });

onDelete(IngredientSchema, async (db, ids, session) => {
  const inIds = { $in: ids };
  await db
    .model('IngredientGroup')
    .updateMany(
      { ingredientIds: inIds },
      { $pull: { ingredientIds: inIds } },
      { session, timestamps: false },
    )
    .exec();
  await db
    .model('IncompatibilityRule')
    .deleteMany(
      { $or: [{ aIngredientId: inIds }, { bIngredientId: inIds }] },
      { session },
    )
    .exec();
  await db
    .model('User')
    .updateMany(
      {
        $or: [{ avoidedIngredientIds: inIds }, { likedIngredientIds: inIds }],
      },
      {
        $pull: {
          avoidedIngredientIds: inIds,
          likedIngredientIds: inIds,
        },
      },
      { session, timestamps: false },
    )
    .exec();
});

@Schema(collectionSchema('ingredient_groups'))
export class IngredientGroup extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  name!: string;

  @Prop({ type: String, default: null })
  description!: string | null;

  @Prop({ type: Boolean, required: true, default: false })
  dietary!: boolean;

  @Prop({ type: [String], required: true, default: [] })
  ingredientIds!: string[];

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const IngredientGroupSchema =
  SchemaFactory.createForClass(IngredientGroup);
IngredientGroupSchema.index({ name: 1 }, { unique: true });
IngredientGroupSchema.index({ ingredientIds: 1 });

onDelete(IngredientGroupSchema, async (db, ids, session) => {
  const inIds = { $in: ids };
  await db
    .model('IncompatibilityRule')
    .deleteMany(
      { $or: [{ aGroupId: inIds }, { bGroupId: inIds }] },
      { session },
    )
    .exec();
  await db
    .model('User')
    .updateMany(
      { avoidedGroupIds: inIds },
      { $pull: { avoidedGroupIds: inIds } },
      { session, timestamps: false },
    )
    .exec();
});

@Schema(collectionSchema('incompatibility_rules'))
export class IncompatibilityRule extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, default: null })
  aIngredientId!: string | null;

  @Prop({ type: String, default: null })
  aGroupId!: string | null;

  @Prop({ type: String, default: null })
  bIngredientId!: string | null;

  @Prop({ type: String, default: null })
  bGroupId!: string | null;

  @Prop({ type: String, required: true })
  reason!: string;

  @Prop({ type: String, default: null })
  source!: string | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const IncompatibilityRuleSchema =
  SchemaFactory.createForClass(IncompatibilityRule);
for (const field of [
  'aIngredientId',
  'aGroupId',
  'bIngredientId',
  'bGroupId',
] as const) {
  IncompatibilityRuleSchema.index({ [field]: 1 });
}

/** One ingredient line inside a recipe, ordered by array position. */
@Schema({ _id: false })
export class RecipeIngredient {
  @Prop({ type: String, required: true })
  ingredientId!: string;

  @Prop({ type: Number, default: null })
  quantity!: number | null;

  @Prop({ type: String, default: null })
  unit!: string | null;

  @Prop({ type: String, default: null })
  note!: string | null;
}

export const RecipeIngredientSchema =
  SchemaFactory.createForClass(RecipeIngredient);

@Schema(collectionSchema('recipes'))
export class Recipe extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, default: null })
  postId!: string | null;

  @Prop({ type: String, default: null })
  createdById!: string | null;

  @Prop({ type: String, required: true })
  title!: string;

  @Prop({ type: String, default: null })
  description!: string | null;

  @Prop({ type: String, default: null })
  imageUrl!: string | null;

  @Prop({ type: Number, required: true })
  servings!: number;

  @Prop({ type: Number, default: null })
  prepMinutes!: number | null;

  @Prop({ type: Number, default: null })
  cookMinutes!: number | null;

  @Prop({ type: [RecipeIngredientSchema], required: true, default: [] })
  ingredients!: RecipeIngredient[];

  @Prop({ type: [String], required: true, default: [] })
  steps!: string[];

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const RecipeSchema = SchemaFactory.createForClass(Recipe);
RecipeSchema.index({ postId: 1 });
RecipeSchema.index({ 'ingredients.ingredientId': 1 });

onDelete(RecipeSchema, async (db, ids, session) => {
  const inIds = { $in: ids };
  await db
    .model('Post')
    .updateMany(
      { 'blog.recipeIds': inIds },
      { $pull: { 'blog.recipeIds': inIds } },
      { session, timestamps: false },
    )
    .exec();
  for (const modelName of [
    'RecipeFavorite',
    'RecipeRating',
    'MealPlanEntry',
  ] as const) {
    await db
      .model(modelName)
      .deleteMany({ recipeId: inIds }, { session })
      .exec();
  }
});

@Schema(collectionSchema('recipe_favorites', 'created'))
export class RecipeFavorite extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  recipeId!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: Date })
  createdAt!: Date;
}

export const RecipeFavoriteSchema =
  SchemaFactory.createForClass(RecipeFavorite);
RecipeFavoriteSchema.index({ recipeId: 1, userId: 1 }, { unique: true });
RecipeFavoriteSchema.index({ userId: 1, createdAt: 1, recipeId: 1 });

@Schema(collectionSchema('recipe_ratings'))
export class RecipeRating extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  recipeId!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: Number, required: true })
  value!: number;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const RecipeRatingSchema = SchemaFactory.createForClass(RecipeRating);
RecipeRatingSchema.index({ recipeId: 1, userId: 1 }, { unique: true });
RecipeRatingSchema.index({ userId: 1 });

@Schema(collectionSchema('meal_plan_entries', 'none'))
export class MealPlanEntry extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: String, enum: Object.values(Weekday), required: true })
  day!: Weekday;

  @Prop({ type: String, enum: Object.values(MealSection), required: true })
  section!: MealSection;

  @Prop({ type: String, required: true })
  recipeId!: string;

  @Prop({ type: Number, required: true })
  position!: number;
}

export const MealPlanEntrySchema = SchemaFactory.createForClass(MealPlanEntry);
MealPlanEntrySchema.index(
  { userId: 1, day: 1, section: 1, recipeId: 1 },
  { unique: true },
);
MealPlanEntrySchema.index({ recipeId: 1 });
