import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createE2eApp, type E2eApp } from './e2e-app';
import { createRecipe, createUser } from './fixtures';

describe('Recipe favorites (e2e)', () => {
  let e2e: E2eApp;
  let token: string;
  let recipeId: string;
  let root: string;
  beforeAll(async () => {
    e2e = await createE2eApp('favorites_e2e');
    token = await e2e.sign(
      await createUser(e2e.mongo, { username: 'favorites.user' }),
    );
    recipeId = (await createRecipe(e2e.mongo)).id;
    root = `/api/v1/recipes/${recipeId}/favorite`;
  });
  afterAll(async () => {
    await e2e.close();
  });
  const favorites = () =>
    e2e.mongo.connection.model('RecipeFavorite').countDocuments();

  it.each([
    ['put', 'favorite'],
    ['delete', 'favorite'],
    ['get', 'favorites'],
  ] as const)('requires auth for %s %s', async (method, kind) => {
    const path = kind === 'favorites' ? '/api/v1/recipes/favorites' : root;
    await request(e2e.app.getHttpServer())[method](path).expect(401);
  });
  it.each(['put', 'delete'] as const)(
    'handles %s without client identity and returns a private state',
    async (method) => {
      const response = await request(e2e.app.getHttpServer())
        [method](root)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(response.body).toEqual({
        recipeId,
        isFavorite: method === 'put',
      });
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(await favorites()).toBe(method === 'put' ? 1 : 0);
    },
  );
  it.each(['put', 'delete'] as const)(
    'rejects a client userId on %s',
    async (method) => {
      await request(e2e.app.getHttpServer())
        [method](root)
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: randomUUID() })
        .expect(400);
      expect(await favorites()).toBe(0);
    },
  );
  it.each(['userId=other', 'page=0', 'limit=51', 'sort=title'])(
    'rejects unsupported favorite query %s',
    async (query) => {
      await request(e2e.app.getHttpServer())
        .get(`/api/v1/recipes/favorites?${query}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    },
  );
  it('routes favorites before :id and returns page metadata for an empty private list', async () => {
    const response = await request(e2e.app.getHttpServer())
      .get('/api/v1/recipes/favorites')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(response.body).toMatchObject({
      items: [],
      meta: { page: 1, totalItems: 0 },
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
  it.each(['put', 'delete'] as const)(
    'returns 404 on %s for a missing recipe',
    async (method) => {
      await request(e2e.app.getHttpServer())
        [method](`/api/v1/recipes/${randomUUID()}/favorite`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    },
  );
});
