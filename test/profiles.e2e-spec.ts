import request from 'supertest';
import { Follow, User } from '../src/mongo/models.js';
import { createE2eApp, type E2eApp } from './e2e-app.js';
import { createPost, createUser } from './fixtures.js';

describe('Profiles and follows (e2e)', () => {
  let e2e: E2eApp;
  let user: User;
  let other: User;
  let token: string;

  beforeAll(async () => {
    e2e = await createE2eApp('profiles_e2e');
    user = await createUser(e2e.mongo, { username: 'vedora.user' });
    other = await createUser(e2e.mongo, {
      username: 'vedora.other',
      email: 'private@vedora.vn',
    });
    token = await e2e.sign(user);
    await createPost(e2e.mongo, { authorId: other.id });
    await createPost(e2e.mongo, { authorId: other.id });
  });

  afterAll(async () => {
    await e2e.close();
  });

  it('serves public profiles without private account data', async () => {
    const response = await request(e2e.app.getHttpServer())
      .get(`/api/v1/profiles/${other.id}`)
      .expect(200);
    expect(response.body).toMatchObject({
      id: other.id,
      postCount: 2,
      followerCount: 0,
      followingCount: 0,
    });
    expect(response.body).not.toHaveProperty('email');
    expect(response.body).not.toHaveProperty('role');
  });

  it('keeps follow mutations private, rejects self-follow and repeats idempotently', async () => {
    await request(e2e.app.getHttpServer())
      .put(`/api/v1/profiles/${other.id}/follow`)
      .expect(401);
    await request(e2e.app.getHttpServer())
      .put(`/api/v1/profiles/${user.id}/follow`)
      .auth(token, { type: 'bearer' })
      .expect(400);
    for (let attempt = 0; attempt < 2; attempt++) {
      await request(e2e.app.getHttpServer())
        .put(`/api/v1/profiles/${other.id}/follow`)
        .auth(token, { type: 'bearer' })
        .expect(204);
    }
    expect(
      await e2e.mongo.connection.model<Follow>(Follow.name).countDocuments({
        followerId: user.id,
        followingId: other.id,
      }),
    ).toBe(1);
  });

  it('exposes follower lists and published posts to guests', async () => {
    const followers = await request(e2e.app.getHttpServer())
      .get(`/api/v1/profiles/${other.id}/followers`)
      .expect(200);
    expect(followers.body).toMatchObject({
      items: [{ id: user.id }],
      nextCursor: null,
    });
    const posts = await request(e2e.app.getHttpServer())
      .get(`/api/v1/posts?authorId=${other.id}`)
      .expect(200);
    expect(posts.body).toMatchObject({ nextCursor: null });
    expect((posts.body as { items: unknown[] }).items).toHaveLength(2);
  });

  it('validates profile edits and never accepts a client-supplied image URL', async () => {
    await request(e2e.app.getHttpServer())
      .patch('/api/v1/profiles/me')
      .auth(token, { type: 'bearer' })
      .send({ avatarUrl: 'https://example.com/forged.png' })
      .expect(400);
    const stored = await e2e.mongo.connection
      .model<User>(User.name)
      .findOne({ _id: user.id })
      .exec();
    expect(stored?.avatarUrl).toBeNull();
  });
});
