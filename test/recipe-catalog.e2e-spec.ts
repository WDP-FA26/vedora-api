import { randomUUID } from 'node:crypto';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import type { PaginatedResponseDto } from '../src/common/pagination';
import type {
  CatalogRecipeDetailDto,
  CatalogRecipeDto,
} from '../src/recipes/dto/recipe-catalog.dto';
import {
  type Ingredient,
  type Post,
  PostStatus,
  type Recipe,
  type RecipeIngredient,
  type User,
} from '../src/mongo/models';
import { createE2eApp, type E2eApp } from './e2e-app';
import {
  createIngredient,
  createPost,
  createRecipe,
  createUser,
} from './fixtures';

describe('Recipe catalog (e2e)', () => {
  let e2e: E2eApp;
  let user: User;
  let token: string;
  let tofu: Ingredient;
  let post: Post;
  let recipe: Recipe;
  const server = () => e2e.app.getHttpServer();

  beforeAll(async () => {
    e2e = await createE2eApp('catalog_e2e');
    user = await createUser(e2e.mongo, { username: 'vedora.user' });
    token = await e2e.sign(user);
    tofu = await createIngredient(e2e.mongo, {
      name: 'Đậu hũ',
      aliases: ['đậu phụ'],
    });
    post = await createPost(e2e.mongo, { authorId: user.id });
    recipe = await createRecipe(
      e2e.mongo,
      {
        title: 'Đậu hũ sốt cà',
        prepMinutes: 10,
        cookMinutes: 5,
        steps: ['Nấu sốt'],
        postId: post.id,
      },
      [tofu.id],
    );
    await e2e.mongo.connection
      .model<RecipeIngredient>('RecipeIngredient')
      .updateMany({ recipeId: recipe.id }, { $set: { quantity: 200.5 } });
  });
  afterEach(async () => {
    await e2e.mongo.connection
      .model<Post>('Post')
      .updateOne({ _id: post.id }, { $set: { status: PostStatus.PUBLISHED } });
  });
  afterAll(async () => {
    await e2e.close();
  });

  const list = (query = '') =>
    request(server()).get(
      query ? `/api/v1/recipes?${query}` : '/api/v1/recipes',
    );

  it('lets guests browse with page metadata and a published source', async () => {
    const response = await list().expect(200);
    const body = response.body as PaginatedResponseDto<CatalogRecipeDto>;
    expect(body).toMatchObject({
      items: [{ id: recipe.id, totalMinutes: 15, post: { id: post.id } }],
      meta: { page: 1, limit: 20, totalItems: 1, totalPages: 1 },
    });
    expect(body.items[0].post).not.toHaveProperty('status');
  });

  it('returns full instructions and numeric ingredient quantities', async () => {
    const response = await request(server())
      .get(`/api/v1/recipes/${recipe.id}`)
      .expect(200);
    const body = response.body as CatalogRecipeDetailDto;
    expect(body).toMatchObject({
      id: recipe.id,
      steps: ['Nấu sốt'],
      totalMinutes: 15,
      ingredients: [{ ingredientId: tofu.id, name: 'Đậu hũ', quantity: 200.5 }],
    });
    expect(body).not.toHaveProperty('createdById');
  });

  it.each([PostStatus.PROCESSING, PostStatus.FAILED])(
    'hides the %s source in list and detail',
    async (status) => {
      await e2e.mongo.connection
        .model<Post>('Post')
        .updateOne({ _id: post.id }, { $set: { status } });
      const listed = await list().expect(200);
      const detail = await request(server())
        .get(`/api/v1/recipes/${recipe.id}`)
        .expect(200);
      expect(
        (listed.body as PaginatedResponseDto<CatalogRecipeDto>).items[0].post,
      ).toBeNull();
      expect((detail.body as CatalogRecipeDetailDto).post).toBeNull();
    },
  );

  it('requires an account for a personalized filter', async () => {
    await list('suitableForMe=true').expect(401);
  });

  it('accepts ordinary users and keeps personalized results out of shared caches', async () => {
    const result = await list('suitableForMe=true')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(
      (result.body as PaginatedResponseDto<CatalogRecipeDto>).items[0],
    ).not.toHaveProperty('avoidedIngredients');
  });

  it.each(['/recipes', '/recipes/anything'])(
    'rejects invalid supplied tokens on %s',
    async (path) => {
      await request(server())
        .get(`/api/v1${path}`)
        .set('Authorization', 'Bearer invalid')
        .expect(401);
    },
  );

  it('trims search text and applies query filters before paging', async () => {
    const found = await request(server())
      .get('/api/v1/recipes')
      .query({ q: ' ĐẬU PHỤ ', maxMinutes: '20' })
      .expect(200);
    expect(
      (found.body as PaginatedResponseDto<CatalogRecipeDto>).meta.totalItems,
    ).toBe(1);
    const tooSlow = await request(server())
      .get('/api/v1/recipes')
      .query({ q: ' ĐẬU PHỤ ', maxMinutes: '10' })
      .expect(200);
    expect(
      (tooSlow.body as PaginatedResponseDto<CatalogRecipeDto>).meta.totalItems,
    ).toBe(0);
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
    await list(query).expect(400);
  });

  it('accepts a zero-minute filter and explicit non-personalized browsing', async () => {
    await list('maxMinutes=0&suitableForMe=false').expect(200);
  });

  it('returns correct totals on an empty out-of-range page', async () => {
    await createRecipe(e2e.mongo, { title: 'Second' });
    await createRecipe(e2e.mongo, { title: 'Third' });
    const response = await list('page=5&limit=2').expect(200);
    const body = response.body as PaginatedResponseDto<CatalogRecipeDto>;
    expect(body).toMatchObject({
      items: [],
      meta: { totalItems: 3, totalPages: 2, page: 5 },
    });
  });

  it('returns 404 for a missing recipe and 400 for an invalid ID', async () => {
    await request(server()).get(`/api/v1/recipes/${randomUUID()}`).expect(404);
    await request(server()).get('/api/v1/recipes/not-a-uuid').expect(400);
  });

  it('documents the filters and manual preview in Swagger', () => {
    const document = SwaggerModule.createDocument(
      e2e.app,
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
