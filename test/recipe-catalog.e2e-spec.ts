import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Prisma, PostStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { PaginatedResponseDto } from '../src/common/pagination';
import type {
  CatalogRecipeDetailDto,
  CatalogRecipeDto,
} from '../src/recipes/dto/recipe-catalog.dto';
import { PrismaService } from '../src/prisma/prisma.service';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const RECIPE_ID = 'd1a2d3e4-0000-4000-8000-000000000001';
const INGREDIENT_ID = 'a1a2d3e4-0000-4000-8000-000000000001';
const POST_ID = 'b1a2d3e4-0000-4000-8000-000000000001';
const now = new Date('2026-10-12T00:00:00Z');
const recipe = {
  id: RECIPE_ID,
  title: 'Đậu hũ sốt cà',
  description: 'Món dễ nấu',
  imageUrl: 'https://example.com/tofu.jpg',
  servings: 2,
  prepMinutes: 10,
  cookMinutes: 5,
  steps: ['Nấu sốt'],
  postId: POST_ID,
  createdById: USER_ID,
  createdAt: now,
  updatedAt: now,
  post: {
    id: POST_ID,
    status: PostStatus.PUBLISHED,
    author: { username: 'vedora.user', fullName: 'Vedora User' },
  },
  ingredients: [
    {
      recipeId: RECIPE_ID,
      ingredientId: INGREDIENT_ID,
      position: 0,
      quantity: new Prisma.Decimal('200.5'),
      unit: 'g',
      note: null,
      ingredient: { name: 'Đậu hũ' },
    },
  ],
};

describe('Public recipe catalog (e2e)', () => {
  const prisma = mockDeep<PrismaService>();
  let app: INestApplication<App>;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    token = await app
      .get(JwtService)
      .signAsync({ sub: USER_ID, username: 'vedora.user' });
  });

  beforeEach(() => {
    mockReset(prisma);
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      username: 'vedora.user',
      role: UserRole.USER,
    } as never);
    prisma.$transaction.mockImplementation((run: unknown) =>
      (run as (tx: PrismaService) => Promise<unknown>)(prisma),
    );
    prisma.$queryRaw.mockImplementation(
      (sql: unknown) =>
        Promise.resolve(
          (sql as Prisma.Sql).text.includes('COUNT(*)')
            ? [{ total: 1n }]
            : [{ id: RECIPE_ID }],
        ) as Prisma.PrismaPromise<unknown>,
    );
    prisma.recipe.findMany.mockResolvedValue([recipe]);
    prisma.recipe.findUnique.mockResolvedValue(recipe);
    prisma.recipeFavorite.findMany.mockResolvedValue([]);
    prisma.recipeFavorite.findUnique.mockResolvedValue(null);
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets guests browse with page metadata and a published source', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/recipes')
      .expect(200);
    const body = response.body as PaginatedResponseDto<CatalogRecipeDto>;
    expect(body).toMatchObject({
      items: [{ id: RECIPE_ID, totalMinutes: 15, post: { id: POST_ID } }],
      meta: { page: 1, limit: 20, totalItems: 1, totalPages: 1 },
    });
    expect(body.items[0].post).not.toHaveProperty('status');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  });

  it('returns full instructions and numeric ingredient quantities', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/recipes/${RECIPE_ID}`)
      .expect(200);
    const body = response.body as CatalogRecipeDetailDto;
    expect(body).toMatchObject({
      id: RECIPE_ID,
      steps: ['Nấu sốt'],
      totalMinutes: 15,
      ingredients: [
        { ingredientId: INGREDIENT_ID, name: 'Đậu hũ', quantity: 200.5 },
      ],
    });
    expect(body).not.toHaveProperty('createdById');
  });

  it.each([PostStatus.PROCESSING, PostStatus.FAILED])(
    'hides the %s source in list and detail',
    async (status) => {
      const privateRecipe = { ...recipe, post: { ...recipe.post, status } };
      prisma.recipe.findMany.mockResolvedValue([privateRecipe]);
      prisma.recipe.findUnique.mockResolvedValue(privateRecipe);
      const list = await request(app.getHttpServer())
        .get('/api/v1/recipes')
        .expect(200);
      const detail = await request(app.getHttpServer())
        .get(`/api/v1/recipes/${RECIPE_ID}`)
        .expect(200);
      expect(
        (list.body as PaginatedResponseDto<CatalogRecipeDto>).items[0].post,
      ).toBeNull();
      expect((detail.body as CatalogRecipeDetailDto).post).toBeNull();
    },
  );

  it('requires an account for a personalized filter', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/recipes?suitableForMe=true')
      .expect(401);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('accepts ordinary users and keeps personalized results out of shared caches', async () => {
    const result = await request(app.getHttpServer())
      .get('/api/v1/recipes?suitableForMe=true')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    const sql = prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.values).toContain(USER_ID);
    expect(
      (result.body as PaginatedResponseDto<CatalogRecipeDto>).items[0],
    ).not.toHaveProperty('avoidedIngredients');
  });

  it.each(['/recipes', `/recipes/${RECIPE_ID}`])(
    'rejects invalid supplied tokens on %s',
    async (path) => {
      await request(app.getHttpServer())
        .get(`/api/v1${path}`)
        .set('Authorization', 'Bearer invalid')
        .expect(401);
      expect(prisma.recipe.findUnique).not.toHaveBeenCalled();
    },
  );

  it('trims search text and applies query filters before paging', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/recipes')
      .query({ q: ' ĐẬU PHỤ ', maxMinutes: '20', page: '2', limit: '5' })
      .expect(200);
    const sql = prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.values).toContain('ĐẬU PHỤ');
    expect(sql.values).toContain(20);
    expect(sql.values.slice(-2)).toEqual([5, 5]);
  });

  it.each([
    'q=',
    'q=%20%20',
    'q=a&q=b',
    `q=${'a'.repeat(101)}`,
    'maxMinutes=',
    'maxMinutes=-1',
    'maxMinutes=1.5',
    'maxMinutes=abc',
    'maxMinutes=2881',
    'maxMinutes=0&maxMinutes=1',
    'suitableForMe=1',
    'suitableForMe=',
    'suitableForMe=true&suitableForMe=false',
    'page=0',
    'limit=51',
    'userId=someone',
    'cursor=anything',
  ])('rejects invalid filters: %s', async (query) => {
    await request(app.getHttpServer())
      .get(`/api/v1/recipes?${query}`)
      .expect(400);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('accepts a zero-minute filter and explicit non-personalized browsing', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/recipes?maxMinutes=0&suitableForMe=false')
      .expect(200);
  });

  it('returns correct totals on an empty out-of-range page', async () => {
    prisma.$queryRaw.mockImplementation(
      (sql: unknown) =>
        Promise.resolve(
          (sql as Prisma.Sql).text.includes('COUNT(*)') ? [{ total: 3n }] : [],
        ) as Prisma.PrismaPromise<unknown>,
    );
    const response = await request(app.getHttpServer())
      .get('/api/v1/recipes?page=5&limit=2')
      .expect(200);
    const body = response.body as PaginatedResponseDto<CatalogRecipeDto>;
    expect(body).toMatchObject({
      items: [],
      meta: { totalItems: 3, totalPages: 2, page: 5 },
    });
    expect(prisma.recipe.findMany).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing recipe and 400 for an invalid ID', async () => {
    prisma.recipe.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get(`/api/v1/recipes/${RECIPE_ID}`)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/recipes/not-a-uuid')
      .expect(400);
  });

  it('documents the filters and manual preview in Swagger', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    expect(document.paths['/api/v1/recipes'].get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'q' }),
        expect.objectContaining({ name: 'maxMinutes' }),
        expect.objectContaining({ name: 'suitableForMe' }),
      ]),
    );
    expect(
      document.paths['/api/v1/meal-plan/preview'].post?.responses,
    ).toHaveProperty('200');
    expect(document.components?.schemas).toHaveProperty('MealPlanPreviewDto');
  });
});
