import { runtimeConfig } from '../../config/runtime-config.js';
import { z } from 'zod';
import { RecipeTag } from '../../mongo/models.js';
import type { PostSourcePart } from '../../posts/summaries/post-source.js';

const MAX_NAME_LENGTH = runtimeConfig.INGREDIENT_NAME_MAX_LENGTH;
const MAX_ALIASES = runtimeConfig.INGREDIENT_MAX_ALIASES;
const MAX_GROUPS = runtimeConfig.INGREDIENT_MAX_GROUPS;
const MAX_TITLE_LENGTH = runtimeConfig.RECIPE_TITLE_MAX_LENGTH;
const MAX_DESCRIPTION_LENGTH = runtimeConfig.RECIPE_DESCRIPTION_MAX_LENGTH;
const MAX_UNIT_LENGTH = runtimeConfig.RECIPE_UNIT_MAX_LENGTH;
const MAX_NOTE_LENGTH = runtimeConfig.RECIPE_NOTE_MAX_LENGTH;
const MAX_STEP_LENGTH = runtimeConfig.RECIPE_STEP_MAX_LENGTH;
const MAX_INGREDIENTS = runtimeConfig.RECIPE_MAX_INGREDIENTS;
const MAX_STEPS = runtimeConfig.RECIPE_MAX_STEPS;
const MAX_SERVINGS = runtimeConfig.RECIPE_MAX_SERVINGS;
const MAX_MINUTES = runtimeConfig.RECIPE_MAX_MINUTES;
const MAX_QUANTITY = runtimeConfig.RECIPE_INGREDIENT_MAX_QUANTITY;

export interface DraftSourceLink {
  title: string;
  url: string;
}

const MAX_CALORIE_NOTE_LENGTH = 500;
const MAX_CALORIE_SOURCES = 6;

const draftSourceSchema = z.object({
  title: z.string(),
  url: z.string(),
});

export const draftOutput = z.object({
  recipe: z
    .object({
      title: z.string(),
      description: z.string().nullable(),
      tag: z.enum(RecipeTag).nullable(),
      servings: z.number().nullable(),
      prepMinutes: z.number().nullable(),
      cookMinutes: z.number().nullable(),
      caloriesPerServing: z.number().nullable().optional(),
      calorieNote: z.string().nullable().optional(),
      calorieSources: z.array(draftSourceSchema).optional(),
      ingredients: z.array(
        z.object({
          name: z.string(),
          quantity: z.number().nullable(),
          unit: z.string().nullable(),
          note: z.string().nullable(),
          catalogRef: z.string().nullable(),
          aliases: z.array(z.string()),
          groupRefs: z.array(z.string()),
        }),
      ),
      steps: z.array(z.string()),
    })
    .nullable(),
  researchCalories: z.boolean(),
});

export type DraftOutput = z.infer<typeof draftOutput>;
export type DraftRecipeOutput = NonNullable<DraftOutput['recipe']>;

export interface DraftRequest {
  parts: readonly PostSourcePart[];
  currentRecipe: string | null;
  instruction: string | null;
}

export function stripDraftTags(text: string): string {
  return text.replace(
    /<\/?(?:source|current_recipe|admin_request|catalog|ingredients|groups)\b[^>]*>?/gi,
    '',
  );
}

export function draftRequestText(request: DraftRequest): string {
  const blocks: string[] = [];
  if (request.parts.length > 0) {
    const sections: string[] = [];
    for (const part of request.parts) {
      sections.push(`## ${part.label}\n${stripDraftTags(part.text)}`);
    }
    blocks.push(`<source>\n${sections.join('\n\n')}\n</source>`);
  }
  if (request.currentRecipe) {
    const recipe = stripDraftTags(request.currentRecipe);
    blocks.push(`<current_recipe>\n${recipe}\n</current_recipe>`);
  }
  if (request.instruction) {
    const instruction = stripDraftTags(request.instruction);
    blocks.push(`<admin_request>\n${instruction}\n</admin_request>`);
  }
  return blocks.join('\n\n');
}

export interface CatalogIngredient {
  id: string;
  name: string;
  aliases: string[];
}

export interface CatalogGroup {
  id: string;
  name: string;
}

export interface DraftCatalog {
  ingredients: Map<string, CatalogIngredient>;
  groups: Map<string, CatalogGroup>;
}

export interface NamedRef {
  id: string;
  name: string;
}

export interface DraftIngredient {
  name: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  match: NamedRef | null;
  suggestion: {
    name: string;
    aliases: string[];
    groups: NamedRef[];
  } | null;
}

export interface RecipeDraft {
  title: string;
  description: string | null;
  tag: RecipeTag | null;
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  caloriesPerServing?: number | null;
  calorieNote?: string | null;
  calorieSources?: DraftSourceLink[];
  ingredients: DraftIngredient[];
  steps: string[];
}

export function buildDraftCatalog(
  ingredients: readonly CatalogIngredient[],
  groups: readonly CatalogGroup[],
): DraftCatalog {
  const catalog: DraftCatalog = { ingredients: new Map(), groups: new Map() };
  ingredients.forEach((ingredient, index) => {
    catalog.ingredients.set(`i${index + 1}`, ingredient);
  });
  groups.forEach((group, index) => {
    catalog.groups.set(`g${index + 1}`, group);
  });
  return catalog;
}

export function describeCatalog(catalog: DraftCatalog): string {
  const lines: string[] = ['<ingredients>'];
  for (const [ref, ingredient] of catalog.ingredients) {
    const aliases = ingredient.aliases.length
      ? ` (${ingredient.aliases.join(', ')})`
      : '';
    lines.push(`${ref}: ${ingredient.name}${aliases}`);
  }
  lines.push('</ingredients>', '<groups>');
  for (const [ref, group] of catalog.groups) {
    lines.push(`${ref}: ${group.name}`);
  }
  lines.push('</groups>');
  return lines.join('\n');
}

export function normalizeName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function toRecipeDraft(
  output: DraftOutput,
  catalog: DraftCatalog,
): RecipeDraft | null {
  const recipe = output.recipe;
  if (!recipe) return null;
  const title = clipText(recipe.title, MAX_TITLE_LENGTH);
  if (!title) return null;

  const byName = indexByName(catalog);
  const ingredients: DraftIngredient[] = [];
  const rowByKey = new Map<string, DraftIngredient>();
  for (const item of recipe.ingredients) {
    const name = clipText(item.name, MAX_NAME_LENGTH);
    if (!name) continue;
    const match = findMatch(item, name, catalog, byName);
    const key = match ? `id:${match.id}` : `name:${normalizeName(name)}`;
    const quantity = toQuantity(item.quantity);
    const unit = clipText(item.unit, MAX_UNIT_LENGTH);
    const note = clipText(item.note, MAX_NOTE_LENGTH);
    const earlier = rowByKey.get(key);
    if (earlier) {
      earlier.note = foldNote(earlier.note, quantity, unit, note);
      continue;
    }
    if (ingredients.length >= MAX_INGREDIENTS) continue;
    const row: DraftIngredient = {
      name,
      quantity,
      unit,
      note,
      match,
      suggestion: match ? null : suggestIngredient(item, name, catalog, byName),
    };
    rowByKey.set(key, row);
    ingredients.push(row);
  }

  const steps: string[] = [];
  for (const step of recipe.steps) {
    const text = clipText(step, MAX_STEP_LENGTH);
    if (text && steps.length < MAX_STEPS) steps.push(text);
  }
  if (ingredients.length === 0 && steps.length === 0) return null;

  return {
    title,
    description: clipText(recipe.description, MAX_DESCRIPTION_LENGTH),
    tag: recipe.tag,
    servings: wholeNumberIn(recipe.servings, 1, MAX_SERVINGS),
    prepMinutes: wholeNumberIn(recipe.prepMinutes, 0, MAX_MINUTES),
    cookMinutes: wholeNumberIn(recipe.cookMinutes, 0, MAX_MINUTES),
    caloriesPerServing: wholeNumberIn(
      recipe.caloriesPerServing ?? null,
      10,
      3000,
    ),
    calorieNote: clipText(recipe.calorieNote ?? null, MAX_CALORIE_NOTE_LENGTH),
    calorieSources: normalizeSources(recipe.calorieSources),
    ingredients,
    steps,
  };
}

export function normalizeSources(
  rawSources?: readonly DraftSourceLink[],
): DraftSourceLink[] {
  if (!rawSources || rawSources.length === 0) return [];
  const seen = new Set<string>();
  const cleaned: DraftSourceLink[] = [];
  for (const item of rawSources) {
    const url = item.url.trim();
    if (!url.startsWith('https://') && !url.startsWith('http://')) continue;
    if (!URL.canParse(url) || seen.has(url)) continue;
    seen.add(url);
    const title = clipText(item.title, 200) || new URL(url).hostname;
    cleaned.push({ title, url });
    if (cleaned.length >= MAX_CALORIE_SOURCES) break;
  }
  return cleaned;
}

function indexByName(catalog: DraftCatalog): Map<string, CatalogIngredient> {
  const byName = new Map<string, CatalogIngredient>();
  for (const ingredient of catalog.ingredients.values()) {
    byName.set(normalizeName(ingredient.name), ingredient);
  }
  for (const ingredient of catalog.ingredients.values()) {
    for (const alias of ingredient.aliases) {
      const key = normalizeName(alias);
      if (!byName.has(key)) byName.set(key, ingredient);
    }
  }
  return byName;
}

type OutputIngredient = NonNullable<
  DraftOutput['recipe']
>['ingredients'][number];

function findMatch(
  item: OutputIngredient,
  name: string,
  catalog: DraftCatalog,
  byName: Map<string, CatalogIngredient>,
): NamedRef | null {
  const fromRef = item.catalogRef
    ? catalog.ingredients.get(item.catalogRef.trim())
    : undefined;
  if (fromRef) return { id: fromRef.id, name: fromRef.name };
  const found = byName.get(normalizeName(name));
  if (!found) return null;
  return { id: found.id, name: found.name };
}

function suggestIngredient(
  item: OutputIngredient,
  name: string,
  catalog: DraftCatalog,
  byName: Map<string, CatalogIngredient>,
): NonNullable<DraftIngredient['suggestion']> {
  const seen = new Set<string>([normalizeName(name)]);
  const aliases: string[] = [];
  for (const raw of item.aliases) {
    const alias = clipText(raw, MAX_NAME_LENGTH);
    if (!alias) continue;
    const key = normalizeName(alias);
    if (seen.has(key) || byName.has(key)) continue;
    seen.add(key);
    if (aliases.length < MAX_ALIASES) aliases.push(alias);
  }
  const groups: NamedRef[] = [];
  const groupIds = new Set<string>();
  for (const ref of item.groupRefs) {
    const group = catalog.groups.get(ref.trim());
    if (!group || groupIds.has(group.id)) continue;
    groupIds.add(group.id);
    if (groups.length < MAX_GROUPS) groups.push({ ...group });
  }
  return { name, aliases, groups };
}

function foldNote(
  note: string | null,
  quantity: number | null,
  unit: string | null,
  extra: string | null,
): string | null {
  const pieces: string[] = [];
  if (quantity !== null) pieces.push(String(quantity));
  if (unit) pieces.push(unit);
  if (extra) pieces.push(extra);
  if (pieces.length === 0) return note;
  const addition = `thêm ${pieces.join(' ')}`;
  const combined = note ? `${note}; ${addition}` : addition;
  return clipText(combined, MAX_NOTE_LENGTH);
}

function clipText(value: string | null, max: number): string | null {
  const text = value?.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  return text.slice(0, max).trim();
}

function toQuantity(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100) / 100;
  if (rounded < 0.01 || rounded > MAX_QUANTITY) return null;
  return rounded;
}

function wholeNumberIn(
  value: number | null,
  min: number,
  max: number,
): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return null;
  return rounded;
}
