import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

// The starter catalog: plant-based Vietnamese ingredients, groups,
// incompatibility rules and recipes from `prisma/seed-data/recipes.json`.
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

/** Read from the working directory: the production image ships `prisma/` beside `dist/`. */
export function loadCatalog(): SeedData {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), 'prisma', 'seed-data', 'recipes.json'),
      'utf8',
    ),
  ) as SeedData;
}

export async function seedCatalog(
  prisma: PrismaClient,
  data: SeedData = loadCatalog(),
): Promise<void> {
  const ingredientIds = new Map<string, string>();
  for (const { name, aliases } of data.ingredients) {
    const row = await prisma.ingredient.upsert({
      where: { name },
      create: { name, aliases },
      update: {},
    });
    ingredientIds.set(name, row.id);
  }
  const ingredientId = (name: string): string => {
    const id = ingredientIds.get(name);
    if (!id) throw new Error(`Unknown ingredient "${name}"`);
    return id;
  };

  const groupIds = new Map<string, string>();
  for (const { name, description, dietary, ingredients } of data.groups) {
    const row = await prisma.ingredientGroup.upsert({
      where: { name },
      create: { name, description, dietary },
      update: {},
    });
    groupIds.set(name, row.id);
    await prisma.ingredientGroupMember.createMany({
      data: ingredients.map((member) => ({
        groupId: row.id,
        ingredientId: ingredientId(member),
      })),
      skipDuplicates: true,
    });
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
    const existing = await prisma.incompatibilityRule.findFirst({
      where: { OR: [pair(a, b), pair(b, a)] },
    });
    if (existing) continue;
    await prisma.incompatibilityRule.create({
      data: { ...pair(a, b), reason: rule.reason, source: rule.source },
    });
    rules++;
  }

  let recipes = 0;
  let photos = 0;
  for (const { ingredients, ...recipe } of data.recipes) {
    const existing = await prisma.recipe.findFirst({
      where: { title: recipe.title },
    });
    if (existing) {
      if (recipe.imageUrl && !existing.imageUrl) {
        await prisma.recipe.update({
          where: { id: existing.id },
          data: { imageUrl: recipe.imageUrl },
        });
        photos++;
      }
      continue;
    }
    await prisma.recipe.create({
      data: {
        ...recipe,
        ingredients: {
          create: ingredients.map((item, position) => ({
            ingredientId: ingredientId(item.name),
            position,
            quantity: item.quantity ?? null,
            unit: item.unit ?? null,
            note: item.note ?? null,
          })),
        },
      },
    });
    recipes++;
  }

  console.log(
    `Catalog: ${ingredientIds.size} ingredients, ${groupIds.size} groups; added ${rules} rules, ${recipes} recipes and ${photos} dish photos.`,
  );
}
