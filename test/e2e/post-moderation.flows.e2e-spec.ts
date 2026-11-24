import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  MediaAsset,
  MediaFailureReason,
  MediaStatus,
  Notification,
  NotificationType,
  type Post,
  PostStatus,
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
  publishedAt: string | null;
  moderationVerdict: string | null;
  moderationReason: string | null;
  moderationFindings: { field: string; quote: string | null; reason: string }[];
  media: { id: string; status: MediaStatus; failureReason: string | null }[];
}

interface ErrorBody {
  statusCode: number;
  code: string;
}

const WEBHOOK_SECRET = 'e2e-api-secret';

/**
 * Post lifecycle around moderation and video processing:
 * PROCESSING → PUBLISHED / PENDING_REVIEW / REJECTED / FAILED, admin decisions,
 * Cloudinary webhooks and the upload endpoints
 * (docs/docs-for-FE/content-moderation.md, errors.md, Swagger).
 */
describe('Post moderation and media flows (e2e)', () => {
  let e2e: E2eApp;
  let author: User;
  let stranger: User;
  let admin: User;
  let authorToken: string;
  let strangerToken: string;
  let adminToken: string;
  const server = () => e2e.app.getHttpServer();
  const model = <T>(name: string) => e2e.mongo.connection.model<T>(name);
  const media = () => model<MediaAsset>(MediaAsset.name);

  beforeAll(async () => {
    e2e = await createE2eApp('post_moderation_flows_e2e');
    author = await createUser(e2e.mongo);
    stranger = await createUser(e2e.mongo);
    admin = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    [authorToken, strangerToken, adminToken] = await Promise.all([
      e2e.sign(author),
      e2e.sign(stranger),
      e2e.sign(admin),
    ]);
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
  const decide = (id: string, payload: object, token = adminToken) =>
    as(
      token,
      request(server()).post(`/api/v1/admin/posts/${id}/moderation`),
    ).send(payload);
  /** The post as its author reads it once the background moderation ended. */
  const settled = async (id: string): Promise<PostBody> => {
    await e2e.settled();
    const response = await as(
      authorToken,
      request(server()).get(`/api/v1/posts/${id}`),
    ).expect(200);
    return response.body as PostBody;
  };
  /** Creates a text post, which waits for moderation, and returns its verdict. */
  const postWith = async (text: string): Promise<PostBody> => {
    const response = await create({ type: 'POST', body: text }).expect(201);
    const created = response.body as PostBody;
    expect(created.status).toBe(PostStatus.PROCESSING);
    return settled(created.id);
  };
  const notificationsFor = (postId: string, type: NotificationType) =>
    model<Notification>(Notification.name)
      .countDocuments({ postId, type })
      .exec();

  describe('creating a post', () => {
    it('publishes clean text once it is checked', async () => {
      const post = await postWith('Canh chua chay');

      expect(post.status).toBe(PostStatus.PUBLISHED);
      expect(post.publishedAt).not.toBeNull();
    });

    it('answers PROCESSING, checks the post in the background and tells the author it was published', async () => {
      const response = await create({
        type: 'POST',
        body: 'Gỏi cuốn chay',
      }).expect(201);
      const created = response.body as PostBody;

      expect(created.status).toBe(PostStatus.PROCESSING);
      expect(created.publishedAt).toBeNull();

      const post = await settled(created.id);
      expect(post.status).toBe(PostStatus.PUBLISHED);
      expect(post.publishedAt).not.toBeNull();
      expect(
        await notificationsFor(created.id, NotificationType.POST_PUBLISHED),
      ).toBe(1);
    });

    it('refuses whitespace-only text without videos with EMPTY_POST', async () => {
      const response = await create({ type: 'POST', body: '   \n\t ' }).expect(
        400,
      );

      expect((response.body as ErrorBody).code).toBe('EMPTY_POST');
    });

    it('refuses a blog through POST /posts', async () => {
      await create({ type: 'BLOG', body: 'x' }).expect(400);
    });

    it('refuses five videos, a repeated video and a malformed id', async () => {
      const ids = Array.from({ length: 5 }, () => randomUUID());
      const repeated = randomUUID();

      await create({ type: 'POST', mediaIds: ids }).expect(400);
      await create({ type: 'POST', mediaIds: [repeated, repeated] }).expect(
        400,
      );
      await create({ type: 'POST', mediaIds: ['nope'] }).expect(400);
    });

    it('does not leave a half-created post behind when a video is unavailable', async () => {
      const before = await model<Post>('Post')
        .countDocuments({ authorId: author.id })
        .exec();

      const response = await create({
        type: 'POST',
        body: 'with missing video',
        mediaIds: [randomUUID()],
      }).expect(400);

      expect((response.body as ErrorBody).code).toBe('MEDIA_UNAVAILABLE');
      expect(
        await model<Post>('Post').countDocuments({ authorId: author.id }),
      ).toBe(before);
    });
  });

  describe('who can see a post in each state', () => {
    it.each([
      PostStatus.PROCESSING,
      PostStatus.PENDING_REVIEW,
      PostStatus.REJECTED,
      PostStatus.FAILED,
    ])('shows a %s post to its author only', async (status) => {
      const post = await createPost(e2e.mongo, {
        authorId: author.id,
        status,
        body: 'x',
        publishedAt: null,
      });
      const path = `/api/v1/posts/${post.id}`;

      await as(authorToken, request(server()).get(path)).expect(200);
      await as(strangerToken, request(server()).get(path)).expect(404);
      await request(server()).get(path).expect(404);
    });

    it('hides the verdict from the author while the post is held', async () => {
      const held = await postWith(`Hơi lạ ${BORDERLINE_MARKER}`);

      expect(held.status).toBe(PostStatus.PENDING_REVIEW);
      expect(held.moderationVerdict).toBeNull();
      expect(held.moderationReason).toBeNull();
      expect(held.moderationFindings).toEqual([]);
    });

    it('tells the author the category, reason text and offending words of a rejection', async () => {
      const rejected = await postWith(`Xấu ${VIOLATION_MARKER}`);

      expect(rejected.status).toBe(PostStatus.REJECTED);
      expect(rejected.moderationVerdict).toBe('violence');
      expect(typeof rejected.moderationReason).toBe('string');
      expect(rejected.moderationFindings).toEqual([
        expect.objectContaining({
          field: 'body',
          quote: VIOLATION_MARKER,
          reason: 'Vi phạm.',
        }),
      ]);
    });
  });

  describe('editing and moderation state', () => {
    it('answers 409 POST_NOT_EDITABLE while a post is PROCESSING', async () => {
      const post = await createPost(e2e.mongo, {
        authorId: author.id,
        status: PostStatus.PROCESSING,
        body: 'x',
        publishedAt: null,
      });

      const response = await patch(post.id, { body: 'y' }).expect(409);

      expect((response.body as ErrorBody).code).toBe('POST_NOT_EDITABLE');
    });

    it('leaves a rejected post rejected when the edit changes nothing', async () => {
      const text = `Xấu ${VIOLATION_MARKER}`;
      const rejected = await postWith(text);

      const response = await patch(rejected.id, { body: `  ${text}  ` }).expect(
        200,
      );

      expect((response.body as PostBody).status).toBe(PostStatus.REJECTED);
    });

    it('moves a held post the author fixes out of the admin queue', async () => {
      const held = await postWith(`Hơi lạ ${BORDERLINE_MARKER}`);

      const fixed = await patch(held.id, { body: 'Đã sửa' }).expect(200);
      const late = await decide(held.id, { decision: 'REJECT' }).expect(409);

      expect((fixed.body as PostBody).status).toBe(PostStatus.PROCESSING);
      expect((late.body as ErrorBody).code).toBe('POST_NOT_REVIEWABLE');
      expect((await settled(held.id)).status).toBe(PostStatus.PUBLISHED);
    });
  });

  describe('admin decisions', () => {
    it('publishes a held post on APPROVE and puts it on the timeline', async () => {
      const held = await postWith(`Hơi lạ ${BORDERLINE_MARKER}`);

      const approved = await decide(held.id, {
        decision: 'APPROVE',
        note: 'ok',
      }).expect(200);
      const timeline = await request(server())
        .get(`/api/v1/posts?authorId=${author.id}&limit=50`)
        .expect(200);

      expect(approved.body).toMatchObject({
        status: PostStatus.PUBLISHED,
        moderation: { reviewedById: admin.id, reviewNote: 'ok' },
      });
      expect((approved.body as PostBody).publishedAt).not.toBeNull();
      expect(
        (timeline.body as { items: { id: string }[] }).items.map(
          ({ id }) => id,
        ),
      ).toContain(held.id);
    });

    it('notifies POST_REJECTED once when a held post is rejected', async () => {
      const held = await postWith(`Hơi lạ ${BORDERLINE_MARKER}`);

      await decide(held.id, { decision: 'REJECT' }).expect(200);

      expect(
        await notificationsFor(held.id, NotificationType.POST_REJECTED),
      ).toBe(1);
    });

    it('confirms an automatic rejection without a new notification', async () => {
      const rejected = await postWith(`Xấu ${VIOLATION_MARKER}`);
      const before = await notificationsFor(
        rejected.id,
        NotificationType.POST_REJECTED,
      );

      const response = await decide(rejected.id, {
        decision: 'REJECT',
        note: 'confirmed',
      }).expect(200);

      expect(response.body).toMatchObject({ status: PostStatus.REJECTED });
      expect(
        await notificationsFor(rejected.id, NotificationType.POST_REJECTED),
      ).toBe(before);
    });

    it('overturns an automatic rejection and tells the author with POST_APPROVED', async () => {
      const rejected = await postWith(`Xấu ${VIOLATION_MARKER}`);

      await decide(rejected.id, { decision: 'APPROVE' }).expect(200);

      expect(
        await notificationsFor(rejected.id, NotificationType.POST_APPROVED),
      ).toBe(1);
    });

    it('lets exactly one of two concurrent decisions on a held post win', async () => {
      const held = await postWith(`Hơi lạ ${BORDERLINE_MARKER}`);

      const responses = await Promise.all([
        decide(held.id, { decision: 'APPROVE' }),
        decide(held.id, { decision: 'APPROVE' }),
      ]);

      const statuses = responses.map(({ status }) => status).sort();
      expect(statuses).toEqual([200, 409]);
      expect(
        await notificationsFor(held.id, NotificationType.POST_APPROVED),
      ).toBe(1);
    });

    it.each([PostStatus.PUBLISHED, PostStatus.PROCESSING, PostStatus.FAILED])(
      'answers 409 POST_NOT_REVIEWABLE for a %s post',
      async (status) => {
        const post = await createPost(e2e.mongo, {
          authorId: author.id,
          status,
          body: 'x',
        });

        const response = await decide(post.id, {
          decision: 'APPROVE',
        }).expect(409);

        expect((response.body as ErrorBody).code).toBe('POST_NOT_REVIEWABLE');
      },
    );

    it('answers 404 for an unknown post, 400 for a note over 500 characters', async () => {
      const held = await postWith(`Hơi lạ ${BORDERLINE_MARKER}`);

      await decide(randomUUID(), { decision: 'APPROVE' }).expect(404);
      await decide(held.id, {
        decision: 'APPROVE',
        note: 'n'.repeat(501),
      }).expect(400);
    });

    it('keeps decisions to admins', async () => {
      const held = await postWith(`Hơi lạ ${BORDERLINE_MARKER}`);

      await decide(held.id, { decision: 'APPROVE' }, authorToken).expect(403);
      await request(server())
        .post(`/api/v1/admin/posts/${held.id}/moderation`)
        .send({ decision: 'APPROVE' })
        .expect(401);
    });
  });

  describe('Cloudinary webhooks', () => {
    const sign = (payload: string, timestamp: string) =>
      createHash('sha1')
        .update(payload + timestamp + WEBHOOK_SECRET)
        .digest('hex');
    const now = () => String(Math.floor(Date.now() / 1000));
    const send = (payload: string, timestamp = now(), signature?: string) =>
      request(server())
        .post('/api/v1/webhooks/cloudinary')
        .set('Content-Type', 'application/json')
        .set('x-cld-timestamp', timestamp)
        .set('x-cld-signature', signature ?? sign(payload, timestamp))
        .send(payload);

    const videoPost = async (mediaStatus: MediaStatus) => {
      const post = await createPost(e2e.mongo, {
        authorId: author.id,
        status: PostStatus.PROCESSING,
        body: 'video',
        publishedAt: null,
      });
      const video = await createMedia(e2e.mongo, {
        ownerId: author.id,
        postId: post.id,
        status: mediaStatus,
      });
      return { post, video };
    };

    it('fails the post when the stream could not be built', async () => {
      const { post, video } = await videoPost(MediaStatus.PROCESSING);

      await send(
        JSON.stringify({
          notification_type: 'eager',
          resource_type: 'video',
          public_id: video.publicId,
          eager: [{ status: 'failed' }],
        }),
      ).expect(204);

      const detail = await as(
        authorToken,
        request(server()).get(`/api/v1/posts/${post.id}`),
      ).expect(200);
      const body = detail.body as PostBody;
      expect(body.status).toBe(PostStatus.FAILED);
      expect(body.media[0]).toMatchObject({
        status: MediaStatus.FAILED,
        failureReason: MediaFailureReason.ENCODING_FAILED,
      });
    });

    it('fails a video that is longer than allowed', async () => {
      const { post, video } = await videoPost(MediaStatus.WAITING_UPLOAD);

      await send(
        JSON.stringify({
          notification_type: 'upload',
          resource_type: 'video',
          public_id: video.publicId,
          duration: 10_000,
          width: 720,
          height: 1280,
        }),
      ).expect(204);

      const row = await media().findById(video.id).exec();
      const postRow = await model<Post>('Post').findById(post.id).exec();
      expect(row).toMatchObject({
        status: MediaStatus.FAILED,
        failureReason: MediaFailureReason.TOO_LONG,
      });
      expect(postRow?.status).toBe(PostStatus.FAILED);
    });

    it('moves an uploaded video to PROCESSING with its duration and aspect ratio', async () => {
      const { video } = await videoPost(MediaStatus.WAITING_UPLOAD);

      await send(
        JSON.stringify({
          notification_type: 'upload',
          resource_type: 'video',
          public_id: video.publicId,
          duration: 12.5,
          width: 1080,
          height: 1920,
        }),
      ).expect(204);

      expect(await media().findById(video.id).exec()).toMatchObject({
        status: MediaStatus.PROCESSING,
        durationSec: 12.5,
        aspectRatio: '9:16',
      });
    });

    it('ignores a repeated failure notification', async () => {
      const { video } = await videoPost(MediaStatus.PROCESSING);
      const payload = JSON.stringify({
        notification_type: 'eager',
        resource_type: 'video',
        public_id: video.publicId,
        eager: [{ status: 'failed' }],
      });

      await send(payload).expect(204);
      await send(payload).expect(204);

      expect((await media().findById(video.id).exec())?.status).toBe(
        MediaStatus.FAILED,
      );
    });

    it('refuses a bad signature and a stale timestamp with 400', async () => {
      const payload = JSON.stringify({ notification_type: 'eager' });
      const stale = String(Math.floor(Date.now() / 1000) - 3 * 60 * 60);

      await send(payload, now(), 'f'.repeat(40)).expect(400);
      await send(payload, stale).expect(400);
    });

    it('answers 400 to a signed body that is not JSON', async () => {
      const response = await send('not json at all');

      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).code).toBe('BAD_REQUEST');
    });

    it('ignores notifications for other folders and other resource types', async () => {
      await send(
        JSON.stringify({
          notification_type: 'upload',
          resource_type: 'image',
          public_id: 'vedora/videos/x',
        }),
      ).expect(204);
      await send(
        JSON.stringify({
          notification_type: 'upload',
          resource_type: 'video',
          public_id: 'elsewhere/clip',
        }),
      ).expect(204);
    });
  });

  describe('uploads', () => {
    it('refuses a sixth unposted upload with 429 UPLOAD_LIMIT_REACHED, not counting failed ones', async () => {
      const uploader = await createUser(e2e.mongo);
      const token = await e2e.sign(uploader);
      await createMedia(e2e.mongo, {
        ownerId: uploader.id,
        status: MediaStatus.FAILED,
      });
      for (let index = 0; index < 5; index += 1) {
        await as(token, request(server()).post('/api/v1/media/uploads'))
          .send({ type: 'VIDEO' })
          .expect(201);
      }

      const response = await as(
        token,
        request(server()).post('/api/v1/media/uploads'),
      )
        .send({ type: 'VIDEO' })
        .expect(429);

      expect((response.body as ErrorBody).code).toBe('UPLOAD_LIMIT_REACHED');
    });

    it('refuses to discard a video attached to a post with 409', async () => {
      const post = await createPost(e2e.mongo, {
        authorId: author.id,
        body: 'x',
      });
      const video = await createMedia(e2e.mongo, {
        ownerId: author.id,
        postId: post.id,
        status: MediaStatus.READY,
      });

      await as(
        authorToken,
        request(server()).delete(`/api/v1/media/${video.id}`),
      ).expect(409);
    });

    it('hides somebody else’s upload', async () => {
      const video = await createMedia(e2e.mongo, {
        ownerId: author.id,
        status: MediaStatus.PROCESSING,
      });

      await as(
        strangerToken,
        request(server()).get(`/api/v1/media/${video.id}`),
      ).expect(404);
      await as(
        strangerToken,
        request(server()).delete(`/api/v1/media/${video.id}`),
      ).expect(404);
    });

    it('does not let a stranger attach somebody else’s upload', async () => {
      const video = await createMedia(e2e.mongo, {
        ownerId: author.id,
        status: MediaStatus.READY,
      });

      const response = await create(
        { type: 'POST', mediaIds: [video.id] },
        strangerToken,
      ).expect(400);

      expect((response.body as ErrorBody).code).toBe('MEDIA_UNAVAILABLE');
      expect((await media().findById(video.id).exec())?.postId).toBeNull();
    });
  });
});
