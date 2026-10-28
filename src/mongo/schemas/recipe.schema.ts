import { randomUUID } from 'node:crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { MealSection, Weekday } from '../enums';
import { collectionSchema, indexName } from './common';
import { Identified } from './user.schema';

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
IngredientSchema.index(
  { name: 1 },
  { unique: true, name: indexName('ingredients', ['name'], 'key') },
);

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

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const IngredientGroupSchema =
  SchemaFactory.createForClass(IngredientGroup);
IngredientGroupSchema.index(
  { name: 1 },
  { unique: true, name: indexName('ingredient_groups', ['name'], 'key') },
);

@Schema(collectionSchema('ingredient_group_members', 'none'))
export class IngredientGroupMember extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  groupId!: string;

  @Prop({ type: String, required: true })
  ingredientId!: string;
}

export const IngredientGroupMemberSchema = SchemaFactory.createForClass(
  IngredientGroupMember,
);
IngredientGroupMemberSchema.index(
  { groupId: 1, ingredientId: 1 },
  {
    unique: true,
    name: indexName(
      'ingredient_group_members',
      ['groupId', 'ingredientId'],
      'key',
    ),
  },
);
IngredientGroupMemberSchema.index(
  { ingredientId: 1 },
  { name: indexName('ingredient_group_members', ['ingredientId'], 'idx') },
);

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
  IncompatibilityRuleSchema.index(
    { [field]: 1 },
    { name: indexName('incompatibility_rules', [field], 'idx') },
  );
}

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

  @Prop({ type: [String], required: true, default: [] })
  steps!: string[];

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export const RecipeSchema = SchemaFactory.createForClass(Recipe);
RecipeSchema.index(
  { postId: 1 },
  { name: indexName('recipes', ['postId'], 'idx') },
);

@Schema(collectionSchema('recipe_ingredients', 'none'))
export class RecipeIngredient extends Identified {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true })
  recipeId!: string;

  @Prop({ type: String, required: true })
  ingredientId!: string;

  @Prop({ type: Number, required: true })
  position!: number;

  @Prop({ type: Number, default: null })
  quantity!: number | null;

  @Prop({ type: String, default: null })
  unit!: string | null;

  @Prop({ type: String, default: null })
  note!: string | null;
}

export const RecipeIngredientSchema =
  SchemaFactory.createForClass(RecipeIngredient);
RecipeIngredientSchema.index(
  { recipeId: 1, ingredientId: 1 },
  {
    unique: true,
    name: indexName('recipe_ingredients', ['recipeId', 'ingredientId'], 'key'),
  },
);
RecipeIngredientSchema.index(
  { ingredientId: 1 },
  { name: indexName('recipe_ingredients', ['ingredientId'], 'idx') },
);

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
RecipeFavoriteSchema.index(
  { recipeId: 1, userId: 1 },
  {
    unique: true,
    name: indexName('recipe_favorites', ['recipeId', 'userId'], 'key'),
  },
);
RecipeFavoriteSchema.index(
  { userId: 1, createdAt: 1, recipeId: 1 },
  {
    name: indexName(
      'recipe_favorites',
      ['userId', 'createdAt', 'recipeId'],
      'idx',
    ),
  },
);

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
RecipeRatingSchema.index(
  { recipeId: 1, userId: 1 },
  {
    unique: true,
    name: indexName('recipe_ratings', ['recipeId', 'userId'], 'key'),
  },
);
RecipeRatingSchema.index(
  { userId: 1 },
  { name: indexName('recipe_ratings', ['userId'], 'idx') },
);

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
  {
    unique: true,
    name: indexName(
      'meal_plan_entries',
      ['userId', 'day', 'section', 'recipeId'],
      'key',
    ),
  },
);
MealPlanEntrySchema.index(
  { recipeId: 1 },
  { name: indexName('meal_plan_entries', ['recipeId'], 'idx') },
);
