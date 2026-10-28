import request from 'supertest';
import { createE2eApp, type E2eApp } from './e2e-app.js';
import { createUser } from './fixtures.js';

describe('Following feed (HTTP)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp('following_feed_e2e');
  });

  afterAll(async () => {
    await e2e.close();
  });

  it('lists only published posts from accounts the viewer follows', async () => {
    const viewer = await createUser(e2e.mongo, { username: 'feed.viewer' });
    const followed = await createUser(e2e.mongo, { username: 'feed.followed' });
    const stranger = await createUser(e2e.mongo, { username: 'feed.stranger' });
    await e2e.connection
      .model('Follow')
      .create({ followerId: viewer.id, followingId: followed.id });

    const followedPost = await request(e2e.app.getHttpServer())
      .post('/api/v1/posts')
      .auth(await e2e.sign(followed), { type: 'bearer' })
      .send({ type: 'POST', body: 'Bài của người đang theo dõi' })
      .expect(201);
    await request(e2e.app.getHttpServer())
      .post('/api/v1/posts')
      .auth(await e2e.sign(stranger), { type: 'bearer' })
      .send({ type: 'POST', body: 'Bài của người lạ' })
      .expect(201);

    const response = await request(e2e.app.getHttpServer())
      .get('/api/v1/posts/following')
      .auth(await e2e.sign(viewer), { type: 'bearer' })
      .expect(200);

    const ids = (response.body as { items: { id: string }[] }).items.map(
      (item) => item.id,
    );
    expect(ids).toEqual([(followedPost.body as { id: string }).id]);
  });

  it('returns an empty page when the viewer follows nobody', async () => {
    const loner = await createUser(e2e.mongo, { username: 'feed.loner' });

    const response = await request(e2e.app.getHttpServer())
      .get('/api/v1/posts/following')
      .auth(await e2e.sign(loner), { type: 'bearer' })
      .expect(200);

    expect(response.body).toEqual({ items: [], nextCursor: null });
  });

  it('requires an account', async () => {
    await request(e2e.app.getHttpServer())
      .get('/api/v1/posts/following')
      .expect(401);
  });
});
