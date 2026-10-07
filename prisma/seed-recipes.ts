import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

// Mock catalog for development: plant-based Vietnamese ingredients, groups,
// incompatibility rules and recipes from `seed-data/recipes.json`. Safe to
// re-run: rows are matched by name or title and never deleted.

type Side = { kind: 'INGREDIENT' | 'GROUP'; name: string };

interface SeedData {
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
    ingredients: {
      name: string;
      quantity?: number;
      unit?: string;
      note?: string;
    }[];
    steps: string[];
  }[];
}

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const data = JSON.parse(
    readFileSync(join(__dirname, 'seed-data', 'recipes.json'), 'utf8'),
  ) as SeedData;

  const ingredientIds = new Map<string, string>();
  for (const { name, aliases } of data.ingredients) {
    const row = await prisma.ingredient.upsert({
      where: { name },
      create: { name, aliases },
      update: { aliases },
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
      update: { description, dietary },
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
  for (const { ingredients, ...recipe } of data.recipes) {
    const existing = await prisma.recipe.findFirst({
      where: { title: recipe.title },
    });
    if (existing) continue;
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
    `Catalog: ${ingredientIds.size} ingredients, ${groupIds.size} groups; added ${rules} rules and ${recipes} recipes.`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
