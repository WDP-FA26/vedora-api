import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

const ADMIN_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const RECIPE_ID = 'd1a2d3e4-0000-4000-8000-000000000001';
const TOFU_ID = 'a1a2d3e4-0000-4000-8000-000000000001';
const HONEY_ID = 'a1a2d3e4-0000-4000-8000-000000000002';
const now = new Date('2026-10-07T08:00:00.000Z');

const recipe = {
  id: RECIPE_ID,
  postId: null,
  createdById: ADMIN_ID,
  title: 'Đậu hũ sốt cà',
  description: null,
  imageUrl: null,
  servings: 2,
  prepMinutes: 10,
  cookMinutes: null,
  steps: ['Chiên đậu', 'Nấu sốt'],
  createdAt: now,
  updatedAt: now,
  post: null,
  ingredients: [
    {
      recipeId: RECIPE_ID,
      ingredientId: TOFU_ID,
      position: 0,
      quantity: new Prisma.Decimal('200.5'),
      unit: 'g',
      note: null,
      ingredient: { name: 'Đậu hũ' },
    },
    {
      recipeId: RECIPE_ID,
      ingredientId: HONEY_ID,
      position: 1,
      quantity: null,
      unit: null,
      note: null,
      ingredient: { name: 'Mật ong' },
    },
  ],
};
const rule = {
  id: 'c1a2d3e4-0000-4000-8000-000000000001',
  aIngredientId: TOFU_ID,
  aGroupId: null,
  bIngredientId: HONEY_ID,
  bGroupId: null,
  reason: 'Dễ gây đầy bụng',
  source: null,
  createdAt: now,
  updatedAt: now,
};
const body = {
  title: ' Đậu hũ sốt cà ',
  servings: 2,
  prepMinutes: 10,
  steps: ['Chiên đậu', 'Nấu sốt'],
  ingredients: [
    { ingredientId: TOFU_ID, quantity: 200.5, unit: 'g' },
    { ingredientId: HONEY_ID },
  ],
};

describe('Recipes and ingredients (e2e)', () => {
  const prisma = mockDeep<PrismaService>();
  let app: INestApplication<App>;
  let token: string;

  function signInAs(role: UserRole) {
    prisma.user.findUnique.mockResolvedValue({
      id: ADMIN_ID,
      username: 'vedora.admin',
      role,
    } as never);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    token = await app.get(JwtService).signAsync({
      sub: ADMIN_ID,
      username: 'vedora.admin',
    });
  });

  beforeEach(() => {
    mockReset(prisma);
    signInAs(UserRole.ADMIN);
    prisma.$transaction.mockImplementation((run: unknown) =>
      Promise.all(run as Promise<unknown>[]),
    );
    prisma.recipe.findUnique.mockResolvedValue(recipe);
    prisma.recipe.create.mockResolvedValue(recipe);
    prisma.ingredientGroupMember.findMany.mockResolvedValue([]);
    prisma.incompatibilityRule.findMany.mockResolvedValue([rule]);
    prisma.ingredient.findMany.mockResolvedValue([
      { id: TOFU_ID, name: 'Đậu hũ' },
      { id: HONEY_ID, name: 'Mật ong' },
    ] as never);
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    'recipes',
    'ingredients',
    'ingredient-groups',
    'incompatibility-rules',
  ])('keeps /admin/%s to admins', async (path) => {
    await request(app.getHttpServer()).get(`/api/v1/admin/${path}`).expect(401);

    signInAs(UserRole.USER);
    await request(app.getHttpServer())
      .get(`/api/v1/admin/${path}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('creates a recipe and reports its incompatible ingredients', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/recipes')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);

    expect(prisma.recipe.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'Đậu hũ sốt cà',
          createdById: ADMIN_ID,
          ingredients: {
            create: [
              expect.objectContaining({ ingredientId: TOFU_ID, position: 0 }),
              expect.objectContaining({ ingredientId: HONEY_ID, position: 1 }),
            ],
          },
        }) as unknown,
      }),
    );
    expect(response.body).toMatchObject({
      id: RECIPE_ID,
      ingredientCount: 2,
      conflictCount: 1,
      ingredients: [
        { name: 'Đậu hũ', quantity: 200.5, unit: 'g' },
        { name: 'Mật ong', quantity: null },
      ],
      conflicts: [{ a: { name: 'Đậu hũ' }, b: { name: 'Mật ong' } }],
    });
  });

  it('rejects a recipe that lists an ingredient twice', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/recipes')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ...body,
        ingredients: [{ ingredientId: TOFU_ID }, { ingredientId: TOFU_ID }],
      })
      .expect(400);
  });

  it('stores a dish photo link and accepts https only', async () => {
    const imageUrl = 'https://upload.wikimedia.org/dish.jpg';

    await request(app.getHttpServer())
      .post('/api/v1/admin/recipes')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...body, imageUrl })
      .expect(201);
    expect(prisma.recipe.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ imageUrl }) as unknown,
      }),
    );

    await request(app.getHttpServer())
      .post('/api/v1/admin/recipes')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...body, imageUrl: 'http://example.com/dish.jpg' })
      .expect(400);
  });

  it('answers 409 when deleting an ingredient a recipe uses', async () => {
    prisma.ingredient.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('fk', {
        code: 'P2003',
        clientVersion: 'test',
      }),
    );

    const response = await request(app.getHttpServer())
      .delete(`/api/v1/admin/ingredients/${TOFU_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect(response.body).toMatchObject({ code: 'INGREDIENT_IN_USE' });
  });

  it('checks a set of ingredients for conflicts', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/admin/recipes/conflicts')
      .set('Authorization', `Bearer ${token}`)
      .send({ ingredientIds: [TOFU_ID, HONEY_ID] })
      .expect(200);
    expect(response.body).toHaveLength(1);
  });

  it('replaces what a signed-in user does not eat', async () => {
    signInAs(UserRole.USER);
    prisma.$transaction.mockResolvedValue([]);
    prisma.userAvoidedIngredient.findMany.mockResolvedValue([
      { ingredient: { id: TOFU_ID, name: 'Đậu hũ' } },
    ] as never);
    prisma.userAvoidedGroup.findMany.mockResolvedValue([]);
    prisma.userLikedIngredient.findMany.mockResolvedValue([
      { ingredient: { id: HONEY_ID, name: 'Mật ong' } },
    ] as never);
    const body = {
      ingredientIds: [TOFU_ID],
      groupIds: [],
      likedIngredientIds: [HONEY_ID],
    };

    await request(app.getHttpServer())
      .put('/api/v1/dietary/me')
      .send(body)
      .expect(401);

    const response = await request(app.getHttpServer())
      .put('/api/v1/dietary/me')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(200);

    expect(prisma.userAvoidedIngredient.createMany).toHaveBeenCalledWith({
      data: [{ userId: ADMIN_ID, ingredientId: TOFU_ID }],
    });
    expect(prisma.userLikedIngredient.createMany).toHaveBeenCalledWith({
      data: [{ userId: ADMIN_ID, ingredientId: HONEY_ID }],
    });
    expect(response.body).toEqual({
      ingredients: [{ id: TOFU_ID, name: 'Đậu hũ' }],
      groups: [],
      liked: [{ id: HONEY_ID, name: 'Mật ong' }],
    });
  });

  it('refuses an ingredient that is both liked and avoided', async () => {
    signInAs(UserRole.USER);

    const response = await request(app.getHttpServer())
      .put('/api/v1/dietary/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ingredientIds: [TOFU_ID],
        groupIds: [],
        likedIngredientIds: [TOFU_ID],
      })
      .expect(400);

    expect(response.body).toMatchObject({ code: 'CONFLICTING_PREFERENCE' });
  });
});
