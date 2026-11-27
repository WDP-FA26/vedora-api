import { describe, expect, it } from 'vitest';
import { RecipeTag } from '@src/mongo/models.js';
import {
  buildDraftCatalog,
  describeCatalog,
  type DraftOutput,
  normalizeName,
  toRecipeDraft,
} from '@src/recipes/drafts/recipe-draft.js';

const TOFU = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Đậu hũ',
  aliases: ['đậu phụ', 'tofu'],
};
const TOMATO = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Cà chua',
  aliases: [],
};
const SOY = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Nước tương',
  aliases: ['xì dầu'],
};
const MUSHROOMS = { id: '44444444-4444-4444-8444-444444444444', name: 'Nấm' };

const catalog = buildDraftCatalog([TOFU, TOMATO, SOY], [MUSHROOMS]);

type OutputRecipe = NonNullable<DraftOutput['recipe']>;
type OutputIngredient = OutputRecipe['ingredients'][number];

function ingredient(
  name: string,
  extra: Partial<OutputIngredient> = {},
): OutputIngredient {
  return {
    name,
    quantity: null,
    unit: null,
    note: null,
    catalogRef: null,
    aliases: [],
    groupRefs: [],
    ...extra,
  };
}

function output(recipe: Partial<OutputRecipe> | null): DraftOutput {
  if (!recipe) return { recipe: null, researchCalories: false };
  return {
    recipe: {
      title: 'Đậu hũ sốt cà chua',
      description: null,
      tag: null,
      servings: null,
      prepMinutes: null,
      cookMinutes: null,
      ingredients: [],
      steps: ['Chiên đậu.'],
      ...recipe,
    },
    researchCalories: true,
  };
}

describe('describeCatalog', () => {
  it('lists each ingredient and group with its short ref', () => {
    expect(describeCatalog(catalog)).toBe(
      [
        '<ingredients>',
        'i1: Đậu hũ (đậu phụ, tofu)',
        'i2: Cà chua',
        'i3: Nước tương (xì dầu)',
        '</ingredients>',
        '<groups>',
        'g1: Nấm',
        '</groups>',
      ].join('\n'),
    );
  });
});

describe('normalizeName', () => {
  it('ignores case, outer spaces and repeated spaces', () => {
    expect(normalizeName('  ĐẬU   Hũ ')).toBe('đậu hũ');
  });

  it('treats decomposed and composed Vietnamese letters alike', () => {
    expect(normalizeName('đậu hũ'.normalize('NFD'))).toBe('đậu hũ');
  });
});

describe('toRecipeDraft', () => {
  it('returns null when the model found no recipe or no title', () => {
    expect(toRecipeDraft(output(null), catalog)).toBeNull();
    expect(toRecipeDraft(output({ title: '   ' }), catalog)).toBeNull();
    expect(
      toRecipeDraft(output({ ingredients: [], steps: ['  '] }), catalog),
    ).toBeNull();
  });

  it('turns a catalog ref into the ingredient id', () => {
    const draft = toRecipeDraft(
      output({ ingredients: [ingredient('tàu hũ', { catalogRef: 'i1' })] }),
      catalog,
    );
    expect(draft?.ingredients[0]).toMatchObject({
      name: 'tàu hũ',
      match: { id: TOFU.id, name: 'Đậu hũ' },
      suggestion: null,
    });
  });

  it('matches by name or alias when the model gave no ref, and ignores unknown refs', () => {
    const draft = toRecipeDraft(
      output({
        ingredients: [
          ingredient('cà chua', { catalogRef: 'i99' }),
          ingredient('Xì Dầu'),
          ingredient('tàu hũ ky', { aliases: ['tofu', 'váng đậu'] }),
        ],
      }),
      catalog,
    );
    const matches = draft?.ingredients.map((row) => row.match?.id ?? null);
    expect(matches).toEqual([TOMATO.id, SOY.id, null]);
    expect(draft?.ingredients[2].suggestion?.aliases).toEqual(['váng đậu']);
  });

  it('suggests a new ingredient with known groups and unused aliases only', () => {
    const draft = toRecipeDraft(
      output({
        ingredients: [
          ingredient('nấm đông cô', {
            aliases: ['nấm hương', 'Nấm đông cô', 'tofu', 'shiitake', ' '],
            groupRefs: ['g1', 'g7', 'g1'],
          }),
        ],
      }),
      catalog,
    );
    expect(draft?.ingredients[0]).toEqual({
      name: 'nấm đông cô',
      quantity: null,
      unit: null,
      note: null,
      match: null,
      suggestion: {
        name: 'nấm đông cô',
        aliases: ['nấm hương', 'shiitake'],
        groups: [MUSHROOMS],
      },
    });
  });

  it('folds a repeated ingredient into the first row', () => {
    const draft = toRecipeDraft(
      output({
        ingredients: [
          ingredient('nước tương', { quantity: 2, unit: 'muỗng canh' }),
          ingredient('xì dầu', { quantity: 1, unit: 'muỗng', note: 'chấm' }),
          ingredient('muối'),
          ingredient('Muối', { note: 'vừa ăn' }),
        ],
      }),
      catalog,
    );
    expect(
      draft?.ingredients.map(({ name, quantity, unit, note }) => ({
        name,
        quantity,
        unit,
        note,
      })),
    ).toEqual([
      {
        name: 'nước tương',
        quantity: 2,
        unit: 'muỗng canh',
        note: 'thêm 1 muỗng chấm',
      },
      { name: 'muối', quantity: null, unit: null, note: 'thêm vừa ăn' },
    ]);
  });

  it('keeps numbers the recipe form accepts and drops the rest', () => {
    const draft = toRecipeDraft(
      output({
        tag: RecipeTag.STIR_FRY,
        servings: 0,
        prepMinutes: 12.4,
        cookMinutes: 5000,
        ingredients: [
          ingredient('cà chua', { quantity: 1.236 }),
          ingredient('đậu hũ', { quantity: 0.001 }),
        ],
      }),
      catalog,
    );
    expect(draft).toMatchObject({
      tag: RecipeTag.STIR_FRY,
      servings: null,
      prepMinutes: 12,
      cookMinutes: null,
    });
    expect(draft?.ingredients.map((row) => row.quantity)).toEqual([1.24, null]);
  });

  it('cuts text to the form limits and drops empty steps', () => {
    const draft = toRecipeDraft(
      output({
        title: 'x'.repeat(400),
        ingredients: [ingredient('cà chua', { unit: 'u'.repeat(50) })],
        steps: ['  Rửa   sạch.  ', '', 's'.repeat(1500)],
      }),
      catalog,
    );
    expect(draft?.title).toHaveLength(150);
    expect(draft?.ingredients[0].unit).toHaveLength(30);
    expect(draft?.steps[0]).toBe('Rửa sạch.');
    expect(draft?.steps[1]).toHaveLength(1000);
    expect(draft?.steps).toHaveLength(2);
  });

  it('keeps at most 50 ingredients', () => {
    const many: OutputIngredient[] = [];
    for (let index = 0; index < 60; index += 1) {
      many.push(ingredient(`gia vị ${index}`));
    }
    const draft = toRecipeDraft(output({ ingredients: many }), catalog);
    expect(draft?.ingredients).toHaveLength(50);
  });

  it('keeps calorieNote and filters valid unique calorieSources', () => {
    const draft = toRecipeDraft(
      output({
        caloriesPerServing: 315,
        calorieNote: '  Tính theo 200g đậu hũ (150 kcal) và sốt cà chua.  ',
        calorieSources: [
          { title: 'USDA Tofu', url: 'https://fdc.nal.usda.gov/tofu' },
          { title: 'Duplicate URL', url: 'https://fdc.nal.usda.gov/tofu' },
          { title: 'Invalid JS URL', url: 'javascript:alert(1)' },
          { title: '', url: 'https://nutrition.org.vn/dau-hu' },
        ],
      }),
      catalog,
    );
    expect(draft?.caloriesPerServing).toBe(315);
    expect(draft?.calorieNote).toBe(
      'Tính theo 200g đậu hũ (150 kcal) và sốt cà chua.',
    );
    expect(draft?.calorieSources).toEqual([
      { title: 'USDA Tofu', url: 'https://fdc.nal.usda.gov/tofu' },
      { title: 'nutrition.org.vn', url: 'https://nutrition.org.vn/dau-hu' },
    ]);
  });
});
