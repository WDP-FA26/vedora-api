import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  Ingredient,
  IngredientGroup,
  IncompatibilityRule,
  Recipe,
} from '../mongo/models.js';
import type { MongoService } from '../mongo/mongo.service.js';

// The starter catalog: plant-based Vietnamese ingredients, groups,
// incompatibility rules and recipes from `seed-data/recipes.json`.
// It runs on every production start, so it only adds what is missing: rows
// are matched by name or title, and nothing an admin edited is overwritten
// or deleted. An existing recipe only gains a photo when it has none.

const sideSchema = z.object({
  kind: z.enum(['INGREDIENT', 'GROUP']),
  name: z.string(),
});

const seedDataSchema = z.object({
  ingredients: z.array(
    z.object({ name: z.string(), aliases: z.array(z.string()) }),
  ),
  groups: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      dietary: z.boolean(),
      ingredients: z.array(z.string()),
    }),
  ),
  rules: z.array(
    z.object({
      a: sideSchema,
      b: sideSchema,
      reason: z.string(),
      source: z.string(),
    }),
  ),
  recipes: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      servings: z.number(),
      prepMinutes: z.number(),
      cookMinutes: z.number(),
      imageUrl: z.string().optional(),
      ingredients: z.array(
        z.object({
          name: z.string(),
          quantity: z.number().optional(),
          unit: z.string().optional(),
          note: z.string().optional(),
        }),
      ),
      steps: z.array(z.string()),
    }),
  ),
});

type Side = z.infer<typeof sideSchema>;
export type SeedData = z.infer<typeof seedDataSchema>;

/** Read from the working directory: the production image ships `seed-data/` beside `dist/`. */
export function loadCatalog(): SeedData {
  const raw: unknown = JSON.parse(
    readFileSync(join(process.cwd(), 'seed-data', 'recipes.json'), 'utf8'),
  );
  return seedDataSchema.parse(raw);
}

export async function seedCatalog(
  mongo: MongoService,
  data: SeedData = loadCatalog(),
): Promise<void> {
  const ingredientsModel = mongo.connection.model<Ingredient>('Ingredient');
  const groupsModel =
    mongo.connection.model<IngredientGroup>('IngredientGroup');
  const rulesModel = mongo.connection.model<IncompatibilityRule>(
    'IncompatibilityRule',
  );
  const recipesModel = mongo.connection.model<Recipe>('Recipe');

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
    const memberIds = ingredients.map(ingredientId);
    let row = await groupsModel.findOne({ name });
    if (row) {
      await groupsModel.updateOne(
        { _id: row.id },
        { $addToSet: { ingredientIds: { $each: memberIds } } },
        { timestamps: false },
      );
    } else {
      row = await groupsModel.create({
        _id: randomUUID(),
        name,
        description,
        dietary,
        ingredientIds: memberIds,
      });
    }
    groupIds.set(name, row.id);
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
    await recipesModel.create({
      _id: randomUUID(),
      ...recipe,
      ingredients: ingredients.map((item) => ({
        ingredientId: ingredientId(item.name),
        quantity: item.quantity ?? null,
        unit: item.unit ?? null,
        note: item.note ?? null,
      })),
    });
    recipes++;
  }

  console.log(
    `Catalog: ${ingredientIds.size} ingredients, ${groupIds.size} groups; added ${rules} rules, ${recipes} recipes and ${photos} dish photos.`,
  );
}
