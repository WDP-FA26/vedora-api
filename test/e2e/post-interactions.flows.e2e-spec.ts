import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  AccountStatus,
  Notification,
  NotificationType,
  type Post,
  PostBookmark,
  PostComment,
  PostLike,
  PostReport,
  PostStatus,
  PostType,
  type User,
  UserRole,
} from '@src/mongo/models.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createPost, createUser } from '@test/support/fixtures.js';

interface LikeBody {
  postId: string;
  isLiked: boolean;
  likeCount: number;
}

interface CommentBody {
  id: string;
  postId: string;
  body: string;
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

interface ErrorBody {
  statusCode: number;
  code: string;
}

interface AdminReport {
  id: string;
  status: string;
  reviewedAt: string | null;
}

describe('Post interaction flows (e2e)', () => {
  let e2e: E2eApp;
  let author: User;
  let fan: User;
  let admin: User;
  let authorToken: string;
  let fanToken: string;
  let adminToken: string;
  const server = () => e2e.app.getHttpServer();
  const model = <T>(name: string) => e2e.mongo.connection.model<T>(name);

  beforeAll(async () => {
    e2e = await createE2eApp('post_interactions_flows_e2e');
    author = await createUser(e2e.mongo);
    fan = await createUser(e2e.mongo);
    admin = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    [authorToken, fanToken, adminToken] = await Promise.all([
      e2e.sign(author),
      e2e.sign(fan),
      e2e.sign(admin),
    ]);
  });
  afterAll(async () => {
    await e2e.close();
  });

  const as = (token: string, req: request.Test) =>
    req.auth(token, { type: 'bearer' });
  const publishedPost = (fields: Partial<Post> = {}) =>
    createPost(e2e.mongo, { authorId: author.id, body: 'Đậu hũ', ...fields });
  const newMember = async () => {
    const user = await createUser(e2e.mongo);
    return { user, token: await e2e.sign(user) };
  };
  const like = (postId: string, token: string) =>
    as(token, request(server()).put(`/api/v1/posts/${postId}/like`));
  const unlike = (postId: string, token: string) =>
    as(token, request(server()).delete(`/api/v1/posts/${postId}/like`));
  const comment = (postId: string, body: string, token = fanToken) =>
    as(token, request(server()).post(`/api/v1/posts/${postId}/comments`)).send({
      body,
    });
  const report = (postId: string, payload: object, token = fanToken) =>
    as(token, request(server()).post(`/api/v1/posts/${postId}/report`)).send(
      payload,
    );
  const notificationsFor = (recipientId: string, type: NotificationType) =>
    model<Notification>(Notification.name)
      .countDocuments({ recipientId, type })
      .exec();

  describe('thích (like)', () => {
    it('counts many concurrent likes from one account once', async () => {
      const post = await publishedPost();

      const responses = await Promise.all(
        Array.from({ length: 8 }, () => like(post.id, fanToken)),
      );

      for (const response of responses) expect(response.status).toBe(200);
      expect(
        await model<PostLike>(PostLike.name).countDocuments({
          postId: post.id,
        }),
      ).toBe(1);
    });

    it('counts one like per account when many accounts like at once', async () => {
      const post = await publishedPost();
      const members = await Promise.all(
        Array.from({ length: 6 }, () => newMember()),
      );

      await Promise.all(members.map(({ token }) => like(post.id, token)));

      const detail = await request(server())
        .get(`/api/v1/posts/${post.id}`)
        .expect(200);
      expect((detail.body as { likeCount: number }).likeCount).toBe(6);
    });

    it('returns the same likeCount in the like response and the post detail', async () => {
      const post = await publishedPost();
      await like(post.id, authorToken).expect(200);

      const liked = await like(post.id, fanToken).expect(200);
      const detail = await as(
        fanToken,
        request(server()).get(`/api/v1/posts/${post.id}`),
      ).expect(200);

      expect(liked.body as LikeBody).toEqual({
        postId: post.id,
        isLiked: true,
        likeCount: 2,
      });
      expect(detail.body).toMatchObject({ likeCount: 2, isLiked: true });
    });

    it('creates a single LIKE notification however often the like is toggled', async () => {
      const post = await publishedPost();
      const { user, token } = await newMember();
      const recipient = author.id;
      const before = await model<Notification>(Notification.name)
        .countDocuments({
          recipientId: recipient,
          actorId: user.id,
          type: NotificationType.LIKE,
        })
        .exec();

      await like(post.id, token).expect(200);
      await unlike(post.id, token).expect(200);
      await like(post.id, token).expect(200);
      await unlike(post.id, token).expect(200);
      await like(post.id, token).expect(200);

      const after = await model<Notification>(Notification.name)
        .countDocuments({
          recipientId: recipient,
          actorId: user.id,
          type: NotificationType.LIKE,
        })
        .exec();
      expect(after - before).toBe(1);
    });

    it.each([
      PostStatus.PROCESSING,
      PostStatus.PENDING_REVIEW,
      PostStatus.REJECTED,
      PostStatus.FAILED,
    ])(
      'answers 404 to a like on a %s post, even for its author',
      async (status) => {
        const post = await publishedPost({ status, publishedAt: null });

        await like(post.id, authorToken).expect(404);
        await like(post.id, fanToken).expect(404);
      },
    );

    it('answers 404 to a like on a draft blog', async () => {
      const draft = await publishedPost({
        type: PostType.BLOG,
        status: PostStatus.DRAFT,
        publishedAt: null,
        body: null,
        blog: {
          title: 'Nháp',
          content: '',
          excerpt: '',
          coverImageUrl: null,
          recipeIds: [],
        },
      });

      await like(draft.id, fanToken).expect(404);
    });

    it('needs a session to like', async () => {
      const post = await publishedPost();

      await request(server()).put(`/api/v1/posts/${post.id}/like`).expect(401);
    });

    it('turns away a suspended account with ACCOUNT_SUSPENDED', async () => {
      const post = await publishedPost();
      const suspended = await createUser(e2e.mongo, {
        status: AccountStatus.SUSPENDED,
      });

      const response = await like(post.id, await e2e.sign(suspended)).expect(
        401,
      );

      expect((response.body as ErrorBody).code).toBe('ACCOUNT_SUSPENDED');
    });

    it('answers 404 for an unknown post and 400 for a malformed id', async () => {
      await like(randomUUID(), fanToken).expect(404);
      await like('not-a-uuid', fanToken).expect(400);
    });
  });

  describe('repost', () => {
    it('counts many concurrent reposts from one account once', async () => {
      const post = await publishedPost();

      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          as(
            fanToken,
            request(server()).put(`/api/v1/posts/${post.id}/repost`),
          ),
        ),
      );

      for (const response of responses) {
        expect(response.body).toMatchObject({
          isReposted: true,
          repostCount: 1,
        });
      }
    });

    it('creates a single REPOST notification however often it is toggled', async () => {
      const post = await publishedPost();
      const { user, token } = await newMember();
      const path = `/api/v1/posts/${post.id}/repost`;

      await as(token, request(server()).put(path)).expect(200);
      await as(token, request(server()).delete(path)).expect(200);
      await as(token, request(server()).put(path)).expect(200);

      expect(
        await model<Notification>(Notification.name).countDocuments({
          recipientId: author.id,
          actorId: user.id,
          type: NotificationType.REPOST,
        }),
      ).toBe(1);
    });
  });

  describe('comments', () => {
    it('accepts 1000 characters after trimming and refuses 1001', async () => {
      const post = await publishedPost();

      await comment(post.id, `  ${'a'.repeat(1000)}  `).expect(201);
      await comment(post.id, 'a'.repeat(1001)).expect(400);
    });

    it('refuses a parentId because replies are not supported', async () => {
      const post = await publishedPost();
      const parent = (await comment(post.id, 'Gốc').expect(201))
        .body as CommentBody;

      await as(
        fanToken,
        request(server()).post(`/api/v1/posts/${post.id}/comments`),
      )
        .send({ body: 'Trả lời', parentId: parent.id })
        .expect(400);
    });

    it('answers 404 when deleting a comment that was already deleted', async () => {
      const post = await publishedPost();
      const created = (await comment(post.id, 'Xoá tôi').expect(201))
        .body as CommentBody;
      const path = `/api/v1/posts/${post.id}/comments/${created.id}`;

      await as(fanToken, request(server()).delete(path)).expect(204);
      await as(fanToken, request(server()).delete(path)).expect(404);
    });

    it('does not let an admin edit somebody else’s comment', async () => {
      const post = await publishedPost();
      const created = (await comment(post.id, 'Của tôi').expect(201))
        .body as CommentBody;

      await as(
        adminToken,
        request(server()).patch(
          `/api/v1/posts/${post.id}/comments/${created.id}`,
        ),
      )
        .send({ body: 'Admin sửa' })
        .expect(403);
    });

    it('pages comments that share a timestamp by id, without gaps or repeats', async () => {
      const post = await publishedPost();
      const createdAt = new Date('2026-10-02T08:00:00.000Z');
      const ids = Array.from({ length: 7 }, () => randomUUID());
      await model<PostComment>(PostComment.name).insertMany(
        ids.map((id) => ({
          _id: id,
          postId: post.id,
          authorId: fan.id,
          body: `comment ${id}`,
          createdAt,
          updatedAt: createdAt,
        })),
      );

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `&cursor=${cursor}` : '';
        const response = await request(server())
          .get(`/api/v1/posts/${post.id}/comments?limit=3${query}`)
          .expect(200);
        const page = response.body as Page<CommentBody>;
        seen.push(...page.items.map(({ id }) => id));
        cursor = page.nextCursor;
      } while (cursor);

      expect(seen).toEqual([...ids].sort().reverse());
    });

    it('accepts limit=50 and refuses 0, 51 and a non-number', async () => {
      const post = await publishedPost();
      const path = `/api/v1/posts/${post.id}/comments`;

      await request(server()).get(`${path}?limit=50`).expect(200);
      await request(server()).get(`${path}?limit=0`).expect(400);
      await request(server()).get(`${path}?limit=51`).expect(400);
      await request(server()).get(`${path}?limit=ten`).expect(400);
    });

    it('answers 404 to listing comments of a post that is not published', async () => {
      const post = await publishedPost({
        status: PostStatus.PENDING_REVIEW,
        publishedAt: null,
      });

      await request(server())
        .get(`/api/v1/posts/${post.id}/comments`)
        .expect(404);
    });

    it('counts comments in commentCount and drops them when deleted', async () => {
      const post = await publishedPost();
      const first = (await comment(post.id, 'Một').expect(201))
        .body as CommentBody;
      await comment(post.id, 'Hai').expect(201);

      await as(
        authorToken,
        request(server()).delete(
          `/api/v1/posts/${post.id}/comments/${first.id}`,
        ),
      ).expect(204);

      const detail = await request(server())
        .get(`/api/v1/posts/${post.id}`)
        .expect(200);
      expect((detail.body as { commentCount: number }).commentCount).toBe(1);
    });
  });

  describe('reports', () => {
    it('accepts exactly one of two concurrent reports by the same account', async () => {
      const post = await publishedPost();
      const { token } = await newMember();

      const responses = await Promise.all([
        report(post.id, { reason: 'SPAM' }, token),
        report(post.id, { reason: 'SPAM' }, token),
      ]);

      const statuses = responses.map(({ status }) => status).sort();
      expect(statuses).toEqual([201, 409]);
      const conflict = responses.find(({ status }) => status === 409);
      expect((conflict?.body as ErrorBody).code).toBe('ALREADY_REPORTED');
    });

    it('refuses to report your own post with OWN_POST', async () => {
      const post = await publishedPost();

      const response = await report(
        post.id,
        { reason: 'SPAM' },
        authorToken,
      ).expect(400);

      expect((response.body as ErrorBody).code).toBe('OWN_POST');
    });

    it('answers 404 to a report on a post that is not published', async () => {
      const post = await publishedPost({
        status: PostStatus.PROCESSING,
        publishedAt: null,
      });

      await report(post.id, { reason: 'SPAM' }).expect(404);
    });

    it('accepts 500 characters of details, refuses 501 and stores blank details as null', async () => {
      const post = await publishedPost();
      const other = await publishedPost();
      const third = await publishedPost();

      await report(post.id, {
        reason: 'OTHER',
        details: 'x'.repeat(500),
      }).expect(201);
      await report(other.id, {
        reason: 'OTHER',
        details: 'x'.repeat(501),
      }).expect(400);
      const blank = await report(third.id, {
        reason: 'OTHER',
        details: '    ',
      }).expect(201);

      expect((blank.body as { details: string | null }).details).toBeNull();
    });

    it('lets an admin close a report once, then answers 409', async () => {
      const post = await publishedPost();
      const created = (await report(post.id, { reason: 'SPAM' }).expect(201))
        .body as { id: string };
      const path = `/api/v1/admin/reports/${created.id}/review`;

      const first = await as(adminToken, request(server()).post(path))
        .send({ status: 'DISMISSED' })
        .expect(200);
      await as(adminToken, request(server()).post(path))
        .send({ status: 'RESOLVED' })
        .expect(409);

      expect(first.body as AdminReport).toMatchObject({
        id: created.id,
        status: 'DISMISSED',
      });
      expect((first.body as AdminReport).reviewedAt).not.toBeNull();
    });

    it('refuses PENDING as a review decision and 404s an unknown report', async () => {
      const post = await publishedPost();
      const created = (await report(post.id, { reason: 'SPAM' }).expect(201))
        .body as { id: string };

      await as(
        adminToken,
        request(server()).post(`/api/v1/admin/reports/${created.id}/review`),
      )
        .send({ status: 'PENDING' })
        .expect(400);
      await as(
        adminToken,
        request(server()).post(`/api/v1/admin/reports/${randomUUID()}/review`),
      )
        .send({ status: 'RESOLVED' })
        .expect(404);
    });

    it('does not let a member close a report', async () => {
      const post = await publishedPost();
      const created = (await report(post.id, { reason: 'SPAM' }).expect(201))
        .body as { id: string };

      await as(
        fanToken,
        request(server()).post(`/api/v1/admin/reports/${created.id}/review`),
      )
        .send({ status: 'DISMISSED' })
        .expect(403);
    });

    it('keeps totalItems equal to the reports an admin can page through', async () => {
      await model<PostReport>(PostReport.name).deleteMany({});
      const reporters = await Promise.all(
        Array.from({ length: 3 }, () => newMember()),
      );
      const post = await publishedPost();
      for (const { token } of reporters) {
        await report(post.id, { reason: 'SPAM' }, token).expect(201);
      }

      const response = await as(
        adminToken,
        request(server()).get('/api/v1/admin/reports?status=PENDING&limit=50'),
      ).expect(200);
      const body = response.body as {
        items: AdminReport[];
        meta: { totalItems: number };
      };

      expect(body.items).toHaveLength(body.meta.totalItems);
      expect(body.meta.totalItems).toBe(3);
    });
  });

  describe('saved posts (bookmarks)', () => {
    const save = (postId: string, token: string) =>
      as(token, request(server()).put(`/api/v1/posts/${postId}/bookmark`));

    const readAllSaved = async (token: string, limit: number) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = cursor ? `&cursor=${cursor}` : '';
        const response = await as(
          token,
          request(server()).get(
            `/api/v1/posts/bookmarks?limit=${limit}${query}`,
          ),
        ).expect(200);
        const page = response.body as Page<{ id: string }>;
        seen.push(...page.items.map(({ id }) => id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 20);
      return seen;
    };

    it('lists saved posts most recently saved first', async () => {
      const { user, token } = await newMember();
      const older = await publishedPost();
      const newer = await publishedPost();
      await model<PostBookmark>(PostBookmark.name).insertMany([
        {
          postId: older.id,
          userId: user.id,
          createdAt: new Date('2026-10-01T00:00:00Z'),
        },
        {
          postId: newer.id,
          userId: user.id,
          createdAt: new Date('2026-10-02T00:00:00Z'),
        },
      ]);

      expect(await readAllSaved(token, 50)).toEqual([newer.id, older.id]);
    });

    it('keeps paging past a saved post that is now held for review', async () => {
      const { user, token } = await newMember();
      const newest = await publishedPost();
      const hidden = await publishedPost();
      const oldest = await publishedPost();
      await model<PostBookmark>(PostBookmark.name).insertMany([
        {
          postId: newest.id,
          userId: user.id,
          createdAt: new Date('2026-10-03T00:00:00Z'),
        },
        {
          postId: hidden.id,
          userId: user.id,
          createdAt: new Date('2026-10-02T00:00:00Z'),
        },
        {
          postId: oldest.id,
          userId: user.id,
          createdAt: new Date('2026-10-01T00:00:00Z'),
        },
      ]);
      await model<Post>('Post')
        .updateOne(
          { _id: hidden.id },
          { $set: { status: PostStatus.PENDING_REVIEW } },
        )
        .exec();

      expect(await readAllSaved(token, 1)).toEqual([newest.id, oldest.id]);
    });

    it('fills a page with saved posts that are still public', async () => {
      const { user, token } = await newMember();
      const visible: Post[] = [];
      const rows: { postId: string; userId: string; createdAt: Date }[] = [];
      for (let index = 0; index < 4; index += 1) {
        const post = await publishedPost();
        if (index % 2 === 0) visible.push(post);
        else {
          await model<Post>('Post')
            .updateOne(
              { _id: post.id },
              { $set: { status: PostStatus.REJECTED } },
            )
            .exec();
        }
        rows.push({
          postId: post.id,
          userId: user.id,
          createdAt: new Date(Date.UTC(2026, 9, 10 - index)),
        });
      }
      await model<PostBookmark>(PostBookmark.name).insertMany(rows);

      const first = await as(
        token,
        request(server()).get('/api/v1/posts/bookmarks?limit=1'),
      ).expect(200);
      const page = first.body as Page<{ id: string }>;

      expect(page.items.map(({ id }) => id)).toEqual([visible[0].id]);
      expect(page.nextCursor).not.toBeNull();
    });

    it('saves concurrently without duplicates', async () => {
      const { user, token } = await newMember();
      const post = await publishedPost();

      await Promise.all(Array.from({ length: 5 }, () => save(post.id, token)));

      expect(
        await model<PostBookmark>(PostBookmark.name).countDocuments({
          postId: post.id,
          userId: user.id,
        }),
      ).toBe(1);
    });
  });

  describe('notifications for interactions', () => {
    it('does not notify the author for their own like', async () => {
      const post = await publishedPost();
      const before = await notificationsFor(author.id, NotificationType.LIKE);

      await like(post.id, authorToken).expect(200);

      expect(await notificationsFor(author.id, NotificationType.LIKE)).toBe(
        before,
      );
    });
  });
});
