import { PrismaClient, Recipe } from '@prisma/client';
import { mockDeep } from 'vitest-mock-extended';
import { SeedData, seedCatalog } from './seed-catalog';

const TOFU_ID = 'a1a2d3e4-0000-4000-8000-000000000001';
const imageUrl = 'https://upload.wikimedia.org/dish.jpg';
const data: SeedData = {
  ingredients: [{ name: 'Đậu hũ', aliases: [] }],
  groups: [],
  rules: [],
  recipes: [
    {
      title: 'Đậu hũ sốt cà',
      description: 'Món mặn',
      imageUrl,
      servings: 2,
      prepMinutes: 10,
      cookMinutes: 15,
      ingredients: [{ name: 'Đậu hũ', quantity: 200, unit: 'g' }],
      steps: ['Chiên đậu'],
    },
  ],
};

describe('Catalog seed', () => {
  const prisma = mockDeep<PrismaClient>();

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    prisma.ingredient.upsert.mockResolvedValue({ id: TOFU_ID } as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('creates a missing recipe with its photo and ingredients', async () => {
    prisma.recipe.findFirst.mockResolvedValue(null);

    await seedCatalog(prisma, data);

    expect(prisma.recipe.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: 'Đậu hũ sốt cà',
        imageUrl,
        ingredients: {
          create: [
            expect.objectContaining({ ingredientId: TOFU_ID, position: 0 }),
          ],
        },
      }) as unknown,
    });
  });

  it('only fills in the photo of a recipe that already exists', async () => {
    prisma.recipe.findFirst.mockResolvedValue({
      id: 'r1',
      imageUrl: null,
    } as Recipe);

    await seedCatalog(prisma, data);

    expect(prisma.recipe.create).not.toHaveBeenCalled();
    expect(prisma.recipe.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { imageUrl },
    });
  });

  it('keeps a photo an admin already chose', async () => {
    prisma.recipe.findFirst.mockResolvedValue({
      id: 'r1',
      imageUrl: 'https://images.pexels.com/other.jpg',
    } as Recipe);

    await seedCatalog(prisma, data);

    expect(prisma.recipe.update).not.toHaveBeenCalled();
  });
});
