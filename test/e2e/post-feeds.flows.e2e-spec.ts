import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Follow, type Post, PostStatus, type User } from '@src/mongo/models.js';
import { PostViewsService } from '@src/posts/post-views.service.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createPost, createUser } from '@test/support/fixtures.js';

interface PostItem {
  id: string;
  status: PostStatus;
  viewCount: number;
  author: { id: string };
}

interface Page {
  items: PostItem[];
  nextCursor: string | null;
}

/**
 * Timeline, following feed and "for you" feed: ordering, tiebreakers,
 * cursor correctness and visibility (docs/docs-for-FE/pagination.md,
 * blogs.md, Swagger descriptions of /posts/feed and /posts/following).
 */
describe('Post feed flows (e2e)', () => {
  let e2e: E2eApp;
  let viewer: User;
  let viewerToken: string;
  const server = () => e2e.app.getHttpServer();
  const model = <T>(name: string) => e2e.mongo.connection.model<T>(name);

  beforeAll(async () => {
    e2e = await createE2eApp('post_feeds_flows_e2e');
    viewer = await createUser(e2e.mongo);
    viewerToken = await e2e.sign(viewer);
  });
  afterAll(async () => {
    await e2e.close();
  });

  const as = (token: string, req: request.Test) =>
    req.auth(token, { type: 'bearer' });

  const readAll = async (
    path: string,
    limit: number,
    token?: string,
  ): Promise<string[]> => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const separator = path.includes('?') ? '&' : '?';
      const query: string = cursor ? `&cursor=${cursor}` : '';
      const req = request(server()).get(
        `${path}${separator}limit=${limit}${query}`,
      );
      const response = await (token ? as(token, req) : req).expect(200);
      const page = response.body as Page;
      seen.push(...page.items.map(({ id }) => id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 50);
    return seen;
  };

  describe('public timeline GET /posts', () => {
    it('pages posts that share publishedAt by id, without gaps or repeats', async () => {
      const author = await createUser(e2e.mongo);
      const publishedAt = new Date('2026-10-05T10:00:00.000Z');
      const ids: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        const post = await createPost(e2e.mongo, {
          authorId: author.id,
          body: `tie ${index}`,
          publishedAt,
        });
        ids.push(post.id);
      }

      const seen = await readAll(`/api/v1/posts?authorId=${author.id}`, 2);

      expect(seen).toEqual([...ids].sort().reverse());
    });

    it('orders by publish time, not creation time', async () => {
      const author = await createUser(e2e.mongo);
      const createdFirstPublishedLast = await createPost(e2e.mongo, {
        authorId: author.id,
        body: 'video took long',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        publishedAt: new Date('2026-10-03T00:00:00Z'),
      });
      const createdLastPublishedFirst = await createPost(e2e.mongo, {
        authorId: author.id,
        body: 'text',
        createdAt: new Date('2026-10-02T00:00:00Z'),
        publishedAt: new Date('2026-10-02T00:00:01Z'),
      });

      const seen = await readAll(`/api/v1/posts?authorId=${author.id}`, 50);

      expect(seen).toEqual([
        createdFirstPublishedLast.id,
        createdLastPublishedFirst.id,
      ]);
    });

    it('never lists a post that is not published', async () => {
      const author = await createUser(e2e.mongo);
      const hiddenStatuses = [
        PostStatus.PROCESSING,
        PostStatus.PENDING_REVIEW,
        PostStatus.REJECTED,
        PostStatus.FAILED,
        PostStatus.DRAFT,
      ];
      for (const status of hiddenStatuses) {
        await createPost(e2e.mongo, {
          authorId: author.id,
          status,
          body: status,
          // A post taken back for review keeps its first publish date.
          publishedAt: new Date(),
        });
      }
      const visible = await createPost(e2e.mongo, {
        authorId: author.id,
        body: 'ok',
      });

      expect(await readAll(`/api/v1/posts?authorId=${author.id}`, 50)).toEqual([
        visible.id,
      ]);
    });

    it('accepts limit=50 and refuses 0, 51, a decimal and a page number', async () => {
      await request(server()).get('/api/v1/posts?limit=50').expect(200);
      await request(server()).get('/api/v1/posts?limit=0').expect(400);
      await request(server()).get('/api/v1/posts?limit=51').expect(400);
      await request(server()).get('/api/v1/posts?limit=1.5').expect(400);
      await request(server()).get('/api/v1/posts?page=2').expect(400);
      await request(server()).get('/api/v1/posts?cursor=abc').expect(400);
    });

    it('refuses an unknown type filter', async () => {
      await request(server()).get('/api/v1/posts?type=VIDEO').expect(400);
    });
  });

  describe('following feed GET /posts/following', () => {
    const follow = (followerId: string, followingId: string) =>
      model<Follow>(Follow.name).create({ followerId, followingId });

    it('pages through every published post of followed accounts without repeats', async () => {
      const { token, id } = await (async () => {
        const user = await createUser(e2e.mongo);
        return { token: await e2e.sign(user), id: user.id };
      })();
      const followed = await createUser(e2e.mongo);
      await follow(id, followed.id);
      const createdAt = new Date('2026-10-05T10:00:00.000Z');
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const post = await createPost(e2e.mongo, {
          authorId: followed.id,
          body: `f ${index}`,
          createdAt,
          publishedAt: createdAt,
        });
        ids.push(post.id);
      }

      const seen = await readAll('/api/v1/posts/following', 2, token);

      expect(seen).toEqual([...ids].sort().reverse());
    });

    it('orders a post approved after review by when it went public, like the timeline', async () => {
      // BUG-2: Following feed sorts by createdAt while every other timeline sorts by publishedAt
      const reader = await createUser(e2e.mongo);
      const readerToken = await e2e.sign(reader);
      const followed = await createUser(e2e.mongo);
      await follow(reader.id, followed.id);
      const heldThenApproved = await createPost(e2e.mongo, {
        authorId: followed.id,
        body: 'held two days, then approved',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        publishedAt: new Date('2026-10-03T00:00:00Z'),
      });
      const publishedRightAway = await createPost(e2e.mongo, {
        authorId: followed.id,
        body: 'published right away',
        createdAt: new Date('2026-10-02T00:00:00Z'),
        publishedAt: new Date('2026-10-02T00:00:00Z'),
      });

      const timeline = await readAll(
        `/api/v1/posts?authorId=${followed.id}`,
        50,
      );
      const following = await readAll(
        '/api/v1/posts/following',
        50,
        readerToken,
      );

      expect(timeline).toEqual([heldThenApproved.id, publishedRightAway.id]);
      expect(following).toEqual(timeline);
    });

    it('drops the posts of an account once it is unfollowed', async () => {
      const reader = await createUser(e2e.mongo);
      const readerToken = await e2e.sign(reader);
      const followed = await createUser(e2e.mongo);
      await follow(reader.id, followed.id);
      await createPost(e2e.mongo, { authorId: followed.id, body: 'x' });

      await model<Follow>(Follow.name)
        .deleteOne({ followerId: reader.id, followingId: followed.id })
        .exec();

      expect(await readAll('/api/v1/posts/following', 50, readerToken)).toEqual(
        [],
      );
    });

    it('refuses limit=51', async () => {
      await as(
        viewerToken,
        request(server()).get('/api/v1/posts/following?limit=51'),
      ).expect(400);
    });
  });

  describe('"for you" feed GET /posts/feed', () => {
    it('never includes the viewer’s own posts', async () => {
      const me = await createUser(e2e.mongo);
      const token = await e2e.sign(me);
      const mine = await createPost(e2e.mongo, { authorId: me.id, body: 'me' });

      const seen = await readAll('/api/v1/posts/feed', 50, token);

      expect(seen).not.toContain(mine.id);
    });

    it('keeps its pages stable when new posts arrive while scrolling', async () => {
      const author = await createUser(e2e.mongo);
      for (let index = 0; index < 4; index += 1) {
        await createPost(e2e.mongo, {
          authorId: author.id,
          body: `feed ${index}`,
          publishedAt: new Date(Date.now() - (index + 1) * 1000),
        });
      }
      const first = await as(
        viewerToken,
        request(server()).get('/api/v1/posts/feed?limit=2'),
      ).expect(200);
      const firstPage = first.body as Page;
      const arrived = await createPost(e2e.mongo, {
        authorId: author.id,
        body: 'arrived later',
        publishedAt: new Date(Date.now() + 1000),
      });

      const second = await as(
        viewerToken,
        request(server()).get(
          `/api/v1/posts/feed?limit=2&cursor=${firstPage.nextCursor}`,
        ),
      ).expect(200);
      const secondIds = (second.body as Page).items.map(({ id }) => id);

      expect(firstPage.nextCursor).not.toBeNull();
      expect(secondIds).not.toContain(arrived.id);
      for (const id of secondIds) {
        expect(firstPage.items.map((item) => item.id)).not.toContain(id);
      }
    });

    it('lists only published posts', async () => {
      const author = await createUser(e2e.mongo);
      const held = await createPost(e2e.mongo, {
        authorId: author.id,
        status: PostStatus.PENDING_REVIEW,
        body: 'held',
      });

      const seen = await readAll('/api/v1/posts/feed', 50, viewerToken);

      expect(seen).not.toContain(held.id);
    });

    it('refuses a malformed cursor and needs a session', async () => {
      await as(
        viewerToken,
        request(server()).get('/api/v1/posts/feed?cursor=abc'),
      ).expect(400);
      await as(
        viewerToken,
        request(server()).get(`/api/v1/posts/feed?cursor=${randomUUID()}`),
      ).expect(400);
      await request(server()).get('/api/v1/posts/feed').expect(401);
    });
  });

  describe('view counts POST /posts/views', () => {
    const views = () => e2e.app.get(PostViewsService);
    const viewCountOf = async (id: string) => {
      const row = await model<Post>('Post').findById(id).exec();
      return row?.viewCount;
    };

    it('counts one view per viewer within the window, and one per distinct viewer', async () => {
      const author = await createUser(e2e.mongo);
      const post = await createPost(e2e.mongo, {
        authorId: author.id,
        body: 'v',
      });
      const other = await createUser(e2e.mongo);
      const otherToken = await e2e.sign(other);

      for (let index = 0; index < 3; index += 1) {
        await as(viewerToken, request(server()).post('/api/v1/posts/views'))
          .send({ postIds: [post.id, post.id] })
          .expect(204);
      }
      await as(otherToken, request(server()).post('/api/v1/posts/views'))
        .send({ postIds: [post.id] })
        .expect(204);
      await views().flush();

      expect(await viewCountOf(post.id)).toBe(2);
    });

    it('does not count views of a post that is not published', async () => {
      const author = await createUser(e2e.mongo);
      const held = await createPost(e2e.mongo, {
        authorId: author.id,
        status: PostStatus.PENDING_REVIEW,
        body: 'h',
      });

      await as(viewerToken, request(server()).post('/api/v1/posts/views'))
        .send({ postIds: [held.id] })
        .expect(204);
      await views().flush();

      expect(await viewCountOf(held.id)).toBe(0);
    });

    it('accepts 50 ids and refuses 51, none, and a malformed id', async () => {
      const ids = (count: number) =>
        Array.from({ length: count }, () => randomUUID());

      await request(server())
        .post('/api/v1/posts/views')
        .send({ postIds: ids(50) })
        .expect(204);
      await request(server())
        .post('/api/v1/posts/views')
        .send({ postIds: ids(51) })
        .expect(400);
      await request(server())
        .post('/api/v1/posts/views')
        .send({ postIds: [] })
        .expect(400);
      await request(server())
        .post('/api/v1/posts/views')
        .send({ postIds: ['nope'] })
        .expect(400);
    });
  });
});
