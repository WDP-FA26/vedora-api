import request from 'supertest';
import {
  Post,
  PostStatus,
  type User,
  UserRole,
} from '../../src/mongo/models.js';
import {
  BORDERLINE_MARKER,
  createE2eApp,
  type E2eApp,
  VIOLATION_MARKER,
} from '../support/e2e-app.js';
import { createUser } from '../support/fixtures.js';

interface PostBody {
  id: string;
  status: PostStatus;
  moderationVerdict: string | null;
  moderation?: {
    verdict: string;
    violationScore: number;
    reviewedById: string | null;
    reviewNote: string | null;
  };
}

interface NotificationBody {
  type: string;
  postId: string | null;
  postType: string | null;
  actor: unknown;
  reason: string | null;
  note: string | null;
}

describe('Content moderation review queue (e2e)', () => {
  let e2e: E2eApp;
  let admin: User;
  let author: User;
  let adminToken: string;
  let authorToken: string;
  const server = () => e2e.app.getHttpServer();
  const posts = () => e2e.mongo.connection.model<Post>(Post.name);

  beforeAll(async () => {
    e2e = await createE2eApp('moderation_e2e');
    admin = await createUser(e2e.mongo, {
      username: 'vedora.admin',
      role: UserRole.ADMIN,
    });
    author = await createUser(e2e.mongo, { username: 'vedora.chef' });
    [adminToken, authorToken] = await Promise.all([
      e2e.sign(admin),
      e2e.sign(author),
    ]);
  });
  beforeEach(async () => {
    await posts().deleteMany({});
  });
  afterAll(async () => {
    await e2e.close();
  });

  const publish = async (body: string): Promise<PostBody> => {
    const response = await request(server())
      .post('/api/v1/posts')
      .auth(authorToken, { type: 'bearer' })
      .send({ type: 'POST', body })
      .expect(201);
    return response.body as PostBody;
  };
  const adminView = async (id: string): Promise<PostBody> => {
    const response = await request(server())
      .get(`/api/v1/admin/posts/${id}`)
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    return response.body as PostBody;
  };
  const moderate = (id: string, decision: string, note?: string) =>
    request(server())
      .post(`/api/v1/admin/posts/${id}/moderation`)
      .auth(adminToken, { type: 'bearer' })
      .send({ decision, note });

  it('publishes a clearly fine post', async () => {
    const created = await publish('Đậu hũ sốt cà');
    expect(created.status).toBe(PostStatus.PUBLISHED);
  });

  it('rejects a confident violation and shows the author why', async () => {
    const created = await publish(`${VIOLATION_MARKER} text`);
    expect(created).toMatchObject({
      status: PostStatus.REJECTED,
      moderationVerdict: 'violence',
    });
  });

  it('holds a doubtful post, hidden from the public, until an admin approves it', async () => {
    const created = await publish(`${BORDERLINE_MARKER} text`);
    expect(created).toMatchObject({
      status: PostStatus.PENDING_REVIEW,
      moderationVerdict: null,
    });
    await request(server()).get(`/api/v1/posts/${created.id}`).expect(404);

    const queue = await request(server())
      .get('/api/v1/admin/posts?status=PENDING_REVIEW')
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    const ids = (queue.body as { items: PostBody[] }).items.map(({ id }) => id);
    expect(ids).toEqual([created.id]);
    expect((await adminView(created.id)).moderation).toMatchObject({
      verdict: 'violence',
      violationScore: 0.6,
    });

    const approved = await moderate(
      created.id,
      'APPROVE',
      'Just a recipe',
    ).expect(200);
    expect(approved.body).toMatchObject({
      status: PostStatus.PUBLISHED,
      moderation: { reviewedById: admin.id, reviewNote: 'Just a recipe' },
    });
    await request(server()).get(`/api/v1/posts/${created.id}`).expect(200);
  });

  it('lets an admin confirm a hold or overturn a rejection', async () => {
    const held = await publish(`${BORDERLINE_MARKER} one`);
    const rejected = await moderate(held.id, 'REJECT').expect(200);
    expect(rejected.body).toMatchObject({ status: PostStatus.REJECTED });

    const blocked = await publish(`${VIOLATION_MARKER} two`);
    const overturned = await moderate(blocked.id, 'APPROVE').expect(200);
    expect(overturned.body).toMatchObject({ status: PostStatus.PUBLISHED });
  });

  it('tells the author what happened to their post', async () => {
    const rejected = await publish(`${VIOLATION_MARKER} one`);
    const held = await publish(`${BORDERLINE_MARKER} two`);
    await moderate(held.id, 'REJECT', 'Chưa rõ ràng').expect(200);
    const approvedLater = await publish(`${BORDERLINE_MARKER} three`);
    await moderate(approvedLater.id, 'APPROVE').expect(200);

    const response = await request(server())
      .get('/api/v1/notifications')
      .auth(authorToken, { type: 'bearer' })
      .expect(200);
    const items = (response.body as { items: NotificationBody[] }).items;
    const pick = (postId: string) =>
      items.filter((item) => item.postId === postId).map((item) => item.type);

    expect(pick(rejected.id)).toEqual(['POST_REJECTED']);
    expect(pick(held.id).sort()).toEqual([
      'POST_PENDING_REVIEW',
      'POST_REJECTED',
    ]);
    expect(pick(approvedLater.id).sort()).toEqual([
      'POST_APPROVED',
      'POST_PENDING_REVIEW',
    ]);
    expect(items.find((item) => item.postId === rejected.id)).toMatchObject({
      actor: null,
      reason: 'violence',
      postType: 'POST',
    });
    expect(
      items.find(
        (item) => item.postId === held.id && item.type === 'POST_REJECTED',
      ),
    ).toMatchObject({ reason: 'violence', note: 'Chưa rõ ràng' });
  });

  it('refuses to moderate a post that is not held or rejected', async () => {
    const created = await publish('Canh chua chay');
    const response = await moderate(created.id, 'REJECT').expect(409);
    expect(response.body).toMatchObject({ code: 'POST_NOT_REVIEWABLE' });
  });

  it('is admin only and rejects unknown decisions', async () => {
    const held = await publish(`${BORDERLINE_MARKER} text`);
    await request(server())
      .post(`/api/v1/admin/posts/${held.id}/moderation`)
      .auth(authorToken, { type: 'bearer' })
      .send({ decision: 'APPROVE' })
      .expect(403);
    await moderate(held.id, 'MAYBE').expect(400);
  });
});
