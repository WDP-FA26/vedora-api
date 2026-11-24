import request from 'supertest';
import {
  MediaAsset,
  MediaStatus,
  Notification,
  NotificationType,
  Post,
  PostBookmark,
  PostComment,
  PostLike,
  PostReport,
  PostRepost,
  PostStatus,
  PostType,
  type User,
  UserRole,
} from '@src/mongo/models.js';
import {
  BORDERLINE_MARKER,
  createE2eApp,
  type E2eApp,
  VIOLATION_MARKER,
} from '@test/support/e2e-app.js';
import { createMedia, createPost, createUser } from '@test/support/fixtures.js';

interface PostBody {
  id: string;
  status: PostStatus;
  body: string | null;
  publishedAt: string | null;
  commentCount?: number;
  likeCount?: number;
}

interface PostPage {
  items: PostBody[];
  nextCursor: string | null;
}

const words = (count: number) =>
  Array.from({ length: count }, () => 'chay').join(' ');

describe('Post lifecycle: create, edit, delete and what hangs off a post (e2e)', () => {
  let e2e: E2eApp;
  let author: User;
  let stranger: User;
  let admin: User;
  let authorToken: string;
  let strangerToken: string;
  let adminToken: string;
  const server = () => e2e.app.getHttpServer();
  const model = <T>(name: string) => e2e.mongo.connection.model<T>(name);
  const posts = () => model<Post>(Post.name);
  const media = () => model<MediaAsset>(MediaAsset.name);

  beforeAll(async () => {
    e2e = await createE2eApp('post_lifecycle_e2e');
    author = await createUser(e2e.mongo, { username: 'vedora.chef' });
    stranger = await createUser(e2e.mongo, { username: 'vedora.other' });
    admin = await createUser(e2e.mongo, {
      username: 'vedora.admin',
      role: UserRole.ADMIN,
    });
    [authorToken, strangerToken, adminToken] = await Promise.all([
      e2e.sign(author),
      e2e.sign(stranger),
      e2e.sign(admin),
    ]);
  });
  beforeEach(async () => {
    for (const name of [
      Post.name,
      MediaAsset.name,
      PostComment.name,
      PostLike.name,
      PostRepost.name,
      PostBookmark.name,
      PostReport.name,
      Notification.name,
    ]) {
      await model(name).deleteMany({});
    }
  });
  afterAll(async () => {
    await e2e.close();
  });

  const as = (token: string, req: request.Test) =>
    req.auth(token, { type: 'bearer' });
  const create = (payload: object, token = authorToken) =>
    as(token, request(server()).post('/api/v1/posts')).send(payload);
  const patch = (id: string, payload: object, token = authorToken) =>
    as(token, request(server()).patch(`/api/v1/posts/${id}`)).send(payload);
  const remove = (id: string, token = authorToken) =>
    as(token, request(server()).delete(`/api/v1/posts/${id}`));
  const publicList = async (query = '') => {
    const response = await request(server())
      .get(`/api/v1/posts?limit=50${query}`)
      .expect(200);
    return (response.body as PostPage).items.map(({ id }) => id);
  };
  /** The post as its author reads it once the background moderation ended. */
  const settled = async (id: string): Promise<PostBody> => {
    await e2e.settled();
    const response = await as(
      authorToken,
      request(server()).get(`/api/v1/posts/${id}`),
    ).expect(200);
    return response.body as PostBody;
  };
  /** Creates a text post, which answers PROCESSING, and returns its verdict. */
  const publish = async (body = 'Đậu hũ sốt cà'): Promise<PostBody> => {
    const response = await create({ type: 'POST', body }).expect(201);
    const created = response.body as PostBody;
    expect(created.status).toBe(PostStatus.PROCESSING);
    return settled(created.id);
  };

  describe('creating a post', () => {
    it('requires a session', async () => {
      await request(server())
        .post('/api/v1/posts')
        .send({ type: 'POST', body: 'Chào' })
        .expect(401);
    });

    it.each([
      ['nothing at all', { type: 'POST' }],
      ['only whitespace', { type: 'POST', body: '   \n  ' }],
      ['empty mediaIds and no text', { type: 'POST', mediaIds: [] }],
      ['a blog type', { type: 'BLOG', body: 'Chào' }],
      ['an unknown field', { type: 'POST', body: 'Chào', title: 'x' }],
      [
        'five videos',
        {
          type: 'POST',
          mediaIds: Array.from({ length: 5 }, () => crypto.randomUUID()),
        },
      ],
      [
        'a duplicated video id',
        {
          type: 'POST',
          mediaIds: [
            '3f9b1c1e-6b1b-4f43-9d6f-1b7e3a5c9a11',
            '3f9b1c1e-6b1b-4f43-9d6f-1b7e3a5c9a11',
          ],
        },
      ],
      ['a media id that is not a uuid', { type: 'POST', mediaIds: ['abc'] }],
    ])('rejects %s', async (_name, payload) => {
      await create(payload).expect(400);
      expect(await posts().countDocuments({})).toBe(0);
    });

    it('accepts exactly 250 words and refuses 251', async () => {
      await create({ type: 'POST', body: words(250) }).expect(201);
      await create({ type: 'POST', body: words(251) }).expect(400);
    });

    it('accepts exactly 2000 characters and refuses 2001', async () => {
      await create({ type: 'POST', body: 'a'.repeat(2000) }).expect(201);
      await create({ type: 'POST', body: 'a'.repeat(2001) }).expect(400);
    });

    it('trims the text', async () => {
      const response = await create({
        type: 'POST',
        body: '  Chào bạn  ',
      }).expect(201);
      expect((response.body as PostBody).body).toBe('Chào bạn');
    });

    it("refuses videos that are someone else's, already used, failed or unknown", async () => {
      const foreign = await createMedia(e2e.mongo, {
        ownerId: stranger.id,
        status: MediaStatus.READY,
      });
      const failed = await createMedia(e2e.mongo, {
        ownerId: author.id,
        status: MediaStatus.FAILED,
      });
      const taken = await createPost(e2e.mongo, {
        authorId: author.id,
        body: 'Bài khác',
      });
      const used = await createMedia(e2e.mongo, {
        ownerId: author.id,
        status: MediaStatus.READY,
        postId: taken.id,
      });
      for (const id of [foreign.id, failed.id, used.id, crypto.randomUUID()]) {
        await create({ type: 'POST', mediaIds: [id] }).expect(400);
      }
      expect(await posts().countDocuments({})).toBe(1);
    });

    it('keeps a post with a video that is still uploading hidden until it is ready', async () => {
      const upload = await createMedia(e2e.mongo, {
        ownerId: author.id,
        status: MediaStatus.PROCESSING,
      });
      const response = await create({
        type: 'POST',
        body: 'Có video',
        mediaIds: [upload.id],
      }).expect(201);
      const created = response.body as PostBody;
      expect(created.status).toBe(PostStatus.PROCESSING);
      expect(await publicList()).not.toContain(created.id);
      await request(server()).get(`/api/v1/posts/${created.id}`).expect(404);
      await as(
        authorToken,
        request(server()).get(`/api/v1/posts/${created.id}`),
      ).expect(200);
    });

    it('never lets a held or rejected post show up for anyone else', async () => {
      const held = await publish(`${BORDERLINE_MARKER} text`);
      const rejected = await publish(`${VIOLATION_MARKER} text`);
      expect(held.status).toBe(PostStatus.PENDING_REVIEW);
      expect(rejected.status).toBe(PostStatus.REJECTED);
      const listed = await publicList();
      expect(listed).not.toContain(held.id);
      expect(listed).not.toContain(rejected.id);
      for (const id of [held.id, rejected.id]) {
        await as(
          strangerToken,
          request(server()).get(`/api/v1/posts/${id}`),
        ).expect(404);
        await as(
          authorToken,
          request(server()).get(`/api/v1/posts/${id}`),
        ).expect(200);
      }
    });
  });

  describe('editing a post', () => {
    it('answers 404 for a blog and for an unknown id, and 400 for a bad id', async () => {
      const blog = await createPost(e2e.mongo, {
        authorId: author.id,
        type: PostType.BLOG,
        body: null,
      });
      await patch(blog.id, { body: 'Sửa blog' }).expect(404);
      await patch(crypto.randomUUID(), { body: 'Không có' }).expect(404);
      await patch('not-a-uuid', { body: 'Sai id' }).expect(400);
    });

    it('rejects unknown fields and bodies over the limits', async () => {
      const created = await publish();
      await patch(created.id, { body: 'ok', status: 'PUBLISHED' }).expect(400);
      await patch(created.id, { body: words(251) }).expect(400);
      await patch(created.id, { body: 'a'.repeat(2001) }).expect(400);
      await patch(created.id, { body: 123 }).expect(400);
      await patch(created.id, { mediaIds: 'x' }).expect(400);
      await patch(created.id, {
        mediaIds: Array.from({ length: 5 }, () => crypto.randomUUID()),
      }).expect(400);
    });

    it('keeps likes, comments, bookmarks and the publish date through an edit', async () => {
      const created = await publish();
      await as(
        strangerToken,
        request(server()).put(`/api/v1/posts/${created.id}/like`),
      ).expect(200);
      await as(
        strangerToken,
        request(server()).put(`/api/v1/posts/${created.id}/bookmark`),
      ).expect(200);
      await as(
        strangerToken,
        request(server()).post(`/api/v1/posts/${created.id}/comments`),
      )
        .send({ body: 'Hay quá' })
        .expect(201);

      const edited = (
        await patch(created.id, { body: 'Đậu hũ sốt cà, bản mới' }).expect(200)
      ).body as PostBody;
      expect(edited.status).toBe(PostStatus.PROCESSING);
      const verdict = await settled(created.id);
      expect(verdict.status).toBe(PostStatus.PUBLISHED);
      expect(verdict.publishedAt).toBe(created.publishedAt);

      const detail = (
        await as(
          strangerToken,
          request(server()).get(`/api/v1/posts/${created.id}`),
        ).expect(200)
      ).body as PostBody;
      expect(detail).toMatchObject({ commentCount: 1, likeCount: 1 });
      expect(
        await model(PostBookmark.name).countDocuments({ postId: created.id }),
      ).toBe(1);
    });

    it('takes an edited post out of every public list while it is checked again, then brings it back', async () => {
      const created = await publish();
      expect(await publicList()).toContain(created.id);

      const upload = await createMedia(e2e.mongo, {
        ownerId: author.id,
        status: MediaStatus.PROCESSING,
      });
      const edited = (
        await patch(created.id, { mediaIds: [upload.id] }).expect(200)
      ).body as PostBody;
      expect(edited.status).toBe(PostStatus.PROCESSING);
      expect(await publicList()).not.toContain(created.id);
      expect(await publicList(`&authorId=${author.id}`)).not.toContain(
        created.id,
      );
      await request(server()).get(`/api/v1/posts/${created.id}`).expect(404);

      const back = (await patch(created.id, { mediaIds: [] }).expect(409))
        .body as { code: string };
      expect(back.code).toBe('POST_NOT_EDITABLE');

      await media().updateOne(
        { _id: upload.id },
        { $set: { status: MediaStatus.READY } },
      );
      await posts().updateOne(
        { _id: created.id },
        { $set: { status: PostStatus.PUBLISHED } },
      );
      expect(await publicList()).toContain(created.id);
    });

    it('stops comments, likes and comment edits on a post that is being checked again', async () => {
      const created = await publish();
      const comment = (
        await as(
          strangerToken,
          request(server()).post(`/api/v1/posts/${created.id}/comments`),
        )
          .send({ body: 'Hay quá' })
          .expect(201)
      ).body as { id: string };
      const upload = await createMedia(e2e.mongo, {
        ownerId: author.id,
        status: MediaStatus.PROCESSING,
      });
      await patch(created.id, { mediaIds: [upload.id] }).expect(200);

      await as(
        strangerToken,
        request(server()).post(`/api/v1/posts/${created.id}/comments`),
      )
        .send({ body: 'Thêm' })
        .expect(404);
      await as(
        strangerToken,
        request(server()).put(`/api/v1/posts/${created.id}/like`),
      ).expect(404);
      await as(
        strangerToken,
        request(server()).patch(
          `/api/v1/posts/${created.id}/comments/${comment.id}`,
        ),
      )
        .send({ body: 'Sửa' })
        .expect(404);
      await as(
        authorToken,
        request(server()).delete(
          `/api/v1/posts/${created.id}/comments/${comment.id}`,
        ),
      ).expect(404);
    });

    it('lets the author edit again after a rejection and publishes the fix', async () => {
      const created = await publish(`${VIOLATION_MARKER} text`);
      expect(created.status).toBe(PostStatus.REJECTED);
      const fixed = (
        await patch(created.id, { body: 'Đã sửa lại' }).expect(200)
      ).body as PostBody;
      expect(fixed.status).toBe(PostStatus.PROCESSING);
      expect((await settled(created.id)).status).toBe(PostStatus.PUBLISHED);
      expect(await publicList()).toContain(created.id);
    });

    it('does not let a stranger or a guest edit, even an admin', async () => {
      const created = await publish();
      await patch(created.id, { body: 'Của người khác' }, strangerToken).expect(
        403,
      );
      await patch(created.id, { body: 'Của admin' }, adminToken).expect(403);
      await request(server())
        .patch(`/api/v1/posts/${created.id}`)
        .send({ body: 'Khách' })
        .expect(401);
      expect((await posts().findById(created.id).exec())?.body).toBe(
        'Đậu hũ sốt cà',
      );
    });
  });

  describe('deleting a post', () => {
    it('removes the post with its comments, likes, reposts, bookmarks, reports and notifications', async () => {
      const created = await publish();
      const base = `/api/v1/posts/${created.id}`;
      await as(strangerToken, request(server()).put(`${base}/like`)).expect(
        200,
      );
      await as(strangerToken, request(server()).put(`${base}/repost`)).expect(
        200,
      );
      await as(strangerToken, request(server()).put(`${base}/bookmark`)).expect(
        200,
      );
      await as(strangerToken, request(server()).post(`${base}/comments`))
        .send({ body: 'Hay quá' })
        .expect(201);
      await as(strangerToken, request(server()).post(`${base}/report`))
        .send({ reason: 'SPAM' })
        .expect(201);
      expect(
        await model(Notification.name).countDocuments({ postId: created.id }),
      ).toBeGreaterThan(0);

      await remove(created.id).expect(204);

      const saved = await posts().findById(created.id).exec();
      expect(saved?.status).toBe(PostStatus.REMOVED);
      // Related rows stay attached so an admin can restore the post if needed.
      expect(
        await model(PostComment.name).countDocuments({ postId: created.id }),
      ).toBe(1);
      await request(server()).get(base).expect(404);
      expect(await publicList()).not.toContain(created.id);
    });

    it('keeps post videos attached on soft-delete so the post can be restored', async () => {
      const upload = await createMedia(e2e.mongo, {
        ownerId: author.id,
        status: MediaStatus.READY,
      });
      const created = (
        await create({
          type: 'POST',
          body: 'Có video',
          mediaIds: [upload.id],
        }).expect(201)
      ).body as PostBody;
      await remove(created.id).expect(204);
      const row = await media().findById(upload.id).exec();
      expect(row?.postId).toBe(created.id);
      expect(row?.discardedAt).toBeNull();
    });

    it('deletes a post that is still being processed, and one held or rejected', async () => {
      const upload = await createMedia(e2e.mongo, {
        ownerId: author.id,
        status: MediaStatus.PROCESSING,
      });
      const processing = (
        await create({
          type: 'POST',
          body: 'Đang xử lý',
          mediaIds: [upload.id],
        }).expect(201)
      ).body as PostBody;
      const held = await publish(`${BORDERLINE_MARKER} text`);
      const rejected = await publish(`${VIOLATION_MARKER} text`);
      for (const id of [processing.id, held.id, rejected.id]) {
        await remove(id).expect(204);
        expect((await posts().findById(id).exec())?.status).toBe(
          PostStatus.REMOVED,
        );
      }
    });

    it('is the author or an admin only, and a second delete is a 404', async () => {
      const created = await publish();
      await remove(created.id, strangerToken).expect(403);
      await request(server()).delete(`/api/v1/posts/${created.id}`).expect(401);
      expect((await posts().findById(created.id).exec())?.status).toBe(
        PostStatus.PUBLISHED,
      );

      await remove(created.id).expect(204);
      await remove(created.id).expect(404);

      const another = await publish('Bài khác');
      await as(
        adminToken,
        request(server()).delete(`/api/v1/admin/posts/${another.id}`),
      ).expect(204);
      expect((await posts().findById(another.id).exec())?.status).toBe(
        PostStatus.REMOVED,
      );
    });
  });

  describe('comments', () => {
    const comment = (postId: string, body: string, token = strangerToken) =>
      as(
        token,
        request(server()).post(`/api/v1/posts/${postId}/comments`),
      ).send({ body });

    it('refuses empty, whitespace-only and over-long text, and a guest', async () => {
      const created = await publish();
      await comment(created.id, '').expect(400);
      await comment(created.id, '    ').expect(400);
      await comment(created.id, 'a'.repeat(1001)).expect(400);
      await comment(created.id, 'a'.repeat(1000)).expect(201);
      await request(server())
        .post(`/api/v1/posts/${created.id}/comments`)
        .send({ body: 'Khách' })
        .expect(401);
    });

    it('lets the comment author, the post author and an admin delete a comment, nobody else', async () => {
      const created = await publish();
      const base = `/api/v1/posts/${created.id}/comments`;
      const ids: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        ids.push(
          (
            (await comment(created.id, `Bình luận ${index}`).expect(201))
              .body as { id: string }
          ).id,
        );
      }
      const bystander = await createUser(e2e.mongo, {
        username: 'vedora.bystander',
      });
      await as(
        await e2e.sign(bystander),
        request(server()).delete(`${base}/${ids[0]}`),
      ).expect(403);
      await as(
        strangerToken,
        request(server()).delete(`${base}/${ids[0]}`),
      ).expect(204);
      await as(
        authorToken,
        request(server()).delete(`${base}/${ids[1]}`),
      ).expect(204);
      await as(
        adminToken,
        request(server()).delete(`${base}/${ids[2]}`),
      ).expect(204);
      await as(
        strangerToken,
        request(server()).delete(`${base}/${ids[0]}`),
      ).expect(404);

      const detail = (
        await request(server()).get(`/api/v1/posts/${created.id}`).expect(200)
      ).body as PostBody;
      expect(detail.commentCount).toBe(1);
    });

    it('only lets the comment author edit, never the post author', async () => {
      const created = await publish();
      const id = (
        (await comment(created.id, 'Gốc').expect(201)).body as { id: string }
      ).id;
      const url = `/api/v1/posts/${created.id}/comments/${id}`;
      await as(authorToken, request(server()).patch(url))
        .send({ body: 'Chủ bài sửa' })
        .expect(403);
      await as(adminToken, request(server()).patch(url))
        .send({ body: 'Admin sửa' })
        .expect(403);
      await as(strangerToken, request(server()).patch(url))
        .send({ body: 'Tự sửa' })
        .expect(200);
      await as(strangerToken, request(server()).patch(url))
        .send({ body: '' })
        .expect(400);
    });

    it('does not mix up comments of different posts', async () => {
      const first = await publish('Bài một');
      const second = await publish('Bài hai');
      const id = (
        (await comment(first.id, 'Của bài một').expect(201)).body as {
          id: string;
        }
      ).id;
      await as(
        strangerToken,
        request(server()).patch(`/api/v1/posts/${second.id}/comments/${id}`),
      )
        .send({ body: 'Sai bài' })
        .expect(404);
      await as(
        strangerToken,
        request(server()).delete(`/api/v1/posts/${second.id}/comments/${id}`),
      ).expect(404);
    });

    it('refuses comments on a draft blog, a held post and a missing post', async () => {
      const held = await publish(`${BORDERLINE_MARKER} text`);
      await comment(held.id, 'Chen vào bài đang chờ').expect(404);
      await comment(crypto.randomUUID(), 'Bài không có').expect(404);
    });

    it('notifies the post author once per comment, but not for their own comment', async () => {
      const created = await publish();
      await comment(created.id, 'Của người khác').expect(201);
      await comment(created.id, 'Của chủ bài', authorToken).expect(201);
      const sent = await model<Notification>(Notification.name)
        .find({
          postId: created.id,
          recipientId: author.id,
          type: { $ne: NotificationType.POST_PUBLISHED },
        })
        .exec();
      expect(sent.map(({ actorId }) => actorId)).toEqual([stranger.id]);
    });
  });

  describe('thích, đăng lại and lưu', () => {
    it.each(['like', 'repost', 'bookmark'] as const)(
      '%s: a guest gets 401 and a missing or held post gets 404',
      async (action) => {
        const created = await publish();
        await request(server())
          .put(`/api/v1/posts/${created.id}/${action}`)
          .expect(401);
        const held = await publish(`${BORDERLINE_MARKER} text`);
        await as(
          strangerToken,
          request(server()).put(`/api/v1/posts/${held.id}/${action}`),
        ).expect(404);
        await as(
          strangerToken,
          request(server()).put(
            `/api/v1/posts/${crypto.randomUUID()}/${action}`,
          ),
        ).expect(404);
      },
    );

    it('counts a like once however often it is repeated, and does not notify for the own post', async () => {
      const created = await publish();
      const url = `/api/v1/posts/${created.id}/like`;
      for (let index = 0; index < 3; index += 1) {
        await as(strangerToken, request(server()).put(url)).expect(200);
      }
      await as(authorToken, request(server()).put(url)).expect(200);
      expect(
        await model(PostLike.name).countDocuments({ postId: created.id }),
      ).toBe(2);
      const sent = await model<Notification>(Notification.name).countDocuments({
        postId: created.id,
        recipientId: author.id,
        type: { $ne: NotificationType.POST_PUBLISHED },
      });
      expect(sent).toBe(1);
      await as(strangerToken, request(server()).delete(url)).expect(200);
      await as(strangerToken, request(server()).delete(url)).expect(200);
      expect(
        await model(PostLike.name).countDocuments({ postId: created.id }),
      ).toBe(1);
    });
  });
});
