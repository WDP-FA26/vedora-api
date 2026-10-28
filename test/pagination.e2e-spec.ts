import { randomUUID } from 'node:crypto';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { MAX_PAGE_NUMBER } from '../src/common/pagination/index.js';
import { UserRole, type Post, type User } from '../src/mongo/models.js';
import { createE2eApp, type E2eApp } from './e2e-app.js';
import { createPost, createUser } from './fixtures.js';

describe('Shared pagination (e2e)', () => {
  let e2e: E2eApp;
  let author: User;
  let token: string;
  let posts: Post[];
  const server = () => e2e.app.getHttpServer();

  beforeAll(async () => {
    e2e = await createE2eApp('pagination_e2e');
    author = await createUser(e2e.mongo, {
      username: 'vedora.user',
      role: UserRole.ADMIN,
    });
    token = await e2e.sign(author);
    // 22 more members: 23 users in all.
    for (let index = 0; index < 22; index++) {
      await createUser(e2e.mongo, {
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
      });
    }
    // Three posts, newest first by publication.
    posts = [];
    for (const minute of [3, 2, 1]) {
      posts.push(
        await createPost(e2e.mongo, {
          authorId: author.id,
          body: `post ${minute}`,
          publishedAt: new Date(Date.UTC(2026, 5, 1, 0, minute)),
        }),
      );
    }
  });

  afterAll(async () => {
    await e2e.close();
  });

  describe('GET /api/v1/users', () => {
    const users = (query = '') =>
      request(server())
        .get(query ? `/api/v1/users?${query}` : '/api/v1/users')
        .auth(token, { type: 'bearer' });

    it('still requires authentication', async () => {
      await request(server()).get('/api/v1/users').expect(401);
    });

    it('returns a bounded first page by default', async () => {
      const response = await users().expect(200);
      const page = response.body as { items: { id: string }[] };
      expect(page.items).toHaveLength(20);
      expect(page.items[0].id).toBe(author.id);
      expect(response.body).toMatchObject({
        meta: {
          page: 1,
          limit: 20,
          totalItems: 23,
          totalPages: 2,
          hasNextPage: true,
          hasPreviousPage: false,
        },
      });
    });

    it('transforms page/limit strings and pages through without overlap', async () => {
      const response = await users('page=2&limit=10').expect(200);
      expect(response.body).toMatchObject({
        meta: {
          page: 2,
          limit: 10,
          totalPages: 3,
          hasPreviousPage: true,
          hasNextPage: true,
        },
      });
      const ids: string[] = [];
      for (const page of [1, 2, 3]) {
        const body = (await users(`page=${page}&limit=10`).expect(200))
          .body as { items: { id: string }[] };
        ids.push(...body.items.map(({ id }) => id));
      }
      expect(ids).toHaveLength(23);
      expect(new Set(ids).size).toBe(23);
    });

    it.each([1, 50])('accepts the limit boundary %i', async (limit) => {
      const response = await users(`limit=${limit}`).expect(200);
      expect(response.body).toMatchObject({ meta: { limit } });
    });

    it('returns an empty out-of-range page with the actual total', async () => {
      const response = await users('page=4&limit=10').expect(200);
      expect(response.body).toMatchObject({
        items: [],
        meta: { page: 4, totalItems: 23, totalPages: 3, hasNextPage: false },
      });
    });

    it('returns an empty result with zero totals', async () => {
      const response = await users('q=no-such-account').expect(200);
      expect(response.body).toMatchObject({
        items: [],
        meta: {
          totalItems: 0,
          totalPages: 0,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      });
    });

    it.each([
      'page=0',
      'page=-1',
      'page=1.5',
      'page=abc',
      'page=',
      `page=${MAX_PAGE_NUMBER + 1}`,
      'page=9007199254740992',
      'limit=0',
      'limit=-1',
      'limit=1.5',
      'limit=abc',
      'limit=',
      'limit=51',
      'limit=Infinity',
      'page=1&page=2',
      'limit=1&limit=2',
      'skip=10',
      'cursor=unexpected',
    ])('rejects invalid pagination: %s', async (query) => {
      await users(query).expect(400);
    });
  });

  describe('GET /api/v1/posts', () => {
    const list = (query = '') =>
      request(server())
        .get(query ? `/api/v1/posts?${query}` : '/api/v1/posts')
        .auth(token, { type: 'bearer' });

    it('preserves the existing cursor response and excludes the lookahead row', async () => {
      const response = await list('limit=2').expect(200);
      expect(response.body).toMatchObject({
        items: [{ id: posts[0].id }, { id: posts[1].id }],
        nextCursor: posts[1].id,
      });
      expect(response.body).not.toHaveProperty('meta');
    });

    it('keeps the author filter and skips the cursor record on the next page', async () => {
      const response = await list(
        `limit=2&cursor=${posts[1].id}&authorId=${author.id}`,
      ).expect(200);
      expect(response.body).toMatchObject({
        items: [{ id: posts[2].id }],
        nextCursor: null,
      });
    });

    it('keeps the default size of twenty', async () => {
      const response = await list().expect(200);
      expect((response.body as { items: unknown[] }).items).toHaveLength(3);
    });

    it('treats an unknown cursor as the end of the feed', async () => {
      const response = await list(`cursor=${randomUUID()}`).expect(200);
      expect(response.body).toEqual({ items: [], nextCursor: null });
    });

    it.each(['limit=0', 'limit=51', 'cursor=invalid', 'page=1'])(
      'inherits cursor validation: %s',
      async (query) => {
        await list(query).expect(400);
      },
    );
  });

  it('documents inherited query fields and concrete item schemas in Swagger', () => {
    const document = SwaggerModule.createDocument(
      e2e.app,
      new DocumentBuilder().build(),
    );
    expect(document.paths['/api/v1/users'].get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'page', in: 'query' }),
        expect.objectContaining({ name: 'limit', in: 'query' }),
      ]),
    );
    expect(document.paths['/api/v1/users'].get?.responses['200']).toMatchObject(
      {
        content: {
          'application/json': {
            schema: {
              allOf: [
                { $ref: '#/components/schemas/PaginatedResponseDto' },
                {
                  properties: {
                    items: {
                      items: { $ref: '#/components/schemas/UserResponseDto' },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    );
    expect(document.components?.schemas?.PostPageDto).toMatchObject({
      properties: {
        items: { items: { $ref: '#/components/schemas/PostResponseDto' } },
        nextCursor: { nullable: true },
      },
    });
  });
});
