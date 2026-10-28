import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Ingredient,
  IngredientGroup,
  IngredientGroupMember,
  IncompatibilityRule,
  Recipe,
  RecipeIngredient,
} from '../mongo/models';
import type { MongoService } from '../mongo/mongo.service';

// The starter catalog: plant-based Vietnamese ingredients, groups,
// incompatibility rules and recipes from `seed-data/recipes.json`.
// It runs on every production start, so it only adds what is missing: rows
// are matched by name or title, and nothing an admin edited is overwritten
// or deleted. An existing recipe only gains a photo when it has none.

type Side = { kind: 'INGREDIENT' | 'GROUP'; name: string };

export interface SeedData {
  ingredients: { name: string; aliases: string[] }[];
  groups: {
    name: string;
    description: string;
    dietary: boolean;
    ingredients: string[];
  }[];
  rules: { a: Side; b: Side; reason: string; source: string }[];
  recipes: {
    title: string;
    description: string;
    servings: number;
    prepMinutes: number;
    cookMinutes: number;
    imageUrl?: string;
    ingredients: {
      name: string;
      quantity?: number;
      unit?: string;
      note?: string;
    }[];
    steps: string[];
  }[];
}

/** Read from the working directory: the production image ships `seed-data/` beside `dist/`. */
export function loadCatalog(): SeedData {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'seed-data', 'recipes.json'), 'utf8'),
  ) as SeedData;
}

export async function seedCatalog(
  mongo: MongoService,
  data: SeedData = loadCatalog(),
): Promise<void> {
  const ingredientsModel = mongo.connection.model<Ingredient>('Ingredient');
  const groupsModel =
    mongo.connection.model<IngredientGroup>('IngredientGroup');
  const membersModel = mongo.connection.model<IngredientGroupMember>(
    'IngredientGroupMember',
  );
  const rulesModel = mongo.connection.model<IncompatibilityRule>(
    'IncompatibilityRule',
  );
  const recipesModel = mongo.connection.model<Recipe>('Recipe');
  const recipeIngredientsModel =
    mongo.connection.model<RecipeIngredient>('RecipeIngredient');

  const ingredientIds = new Map<string, string>();
  for (const { name, aliases } of data.ingredients) {
    const row =
      (await ingredientsModel.findOne({ name })) ??
      (await ingredientsModel.create({ _id: randomUUID(), name, aliases }));
    ingredientIds.set(name, row.id);
  }
  const ingredientId = (name: string): string => {
    const id = ingredientIds.get(name);
    if (!id) throw new Error(`Unknown ingredient "${name}"`);
    return id;
  };

  const groupIds = new Map<string, string>();
  for (const { name, description, dietary, ingredients } of data.groups) {
    const row =
      (await groupsModel.findOne({ name })) ??
      (await groupsModel.create({
        _id: randomUUID(),
        name,
        description,
        dietary,
      }));
    groupIds.set(name, row.id);
    for (const member of ingredients) {
      const key = { groupId: row.id, ingredientId: ingredientId(member) };
      const exists = await membersModel.findOne(key);
      if (!exists) {
        await membersModel.create({ _id: randomUUID(), ...key });
      }
    }
  }

  const side = ({ kind, name }: Side) => {
    if (kind === 'INGREDIENT') {
      return { ingredientId: ingredientId(name), groupId: null };
    }
    const groupId = groupIds.get(name);
    if (!groupId) throw new Error(`Unknown group "${name}"`);
    return { ingredientId: null, groupId };
  };
  let rules = 0;
  for (const rule of data.rules) {
    const a = side(rule.a);
    const b = side(rule.b);
    const pair = (first: typeof a, second: typeof a) => ({
      aIngredientId: first.ingredientId,
      aGroupId: first.groupId,
      bIngredientId: second.ingredientId,
      bGroupId: second.groupId,
    });
    const existing = await rulesModel.findOne({
      $or: [pair(a, b), pair(b, a)],
    });
    if (existing) continue;
    await rulesModel.create({
      _id: randomUUID(),
      ...pair(a, b),
      reason: rule.reason,
      source: rule.source,
    });
    rules++;
  }

  let recipes = 0;
  let photos = 0;
  for (const { ingredients, ...recipe } of data.recipes) {
    const existing = await recipesModel.findOne({ title: recipe.title });
    if (existing) {
      if (recipe.imageUrl && !existing.imageUrl) {
        await recipesModel.updateOne(
          { _id: existing.id },
          { $set: { imageUrl: recipe.imageUrl } },
        );
        photos++;
      }
      continue;
    }
    // MongoDB has no nested writes: create the recipe, then its ingredients.
    const created = await recipesModel.create({
      _id: randomUUID(),
      ...recipe,
    });
    if (ingredients.length > 0) {
      await recipeIngredientsModel.insertMany(
        ingredients.map((item, position) => ({
          _id: randomUUID(),
          recipeId: created.id,
          ingredientId: ingredientId(item.name),
          position,
          quantity: item.quantity ?? null,
          unit: item.unit ?? null,
          note: item.note ?? null,
        })),
      );
    }
    recipes++;
  }

  console.log(
    `Catalog: ${ingredientIds.size} ingredients, ${groupIds.size} groups; added ${rules} rules, ${recipes} recipes and ${photos} dish photos.`,
  );
}
