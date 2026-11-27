import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { z } from 'zod';
import {
  AccountStatus,
  Follow,
  Notification,
  NotificationType,
  User,
} from '@src/mongo/models.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createUser } from '@test/support/fixtures.js';

const PROFILE_SUMMARY_KEYS = [
  'avatarUrl',
  'bio',
  'coverUrl',
  'fullName',
  'id',
  'isProfessional',
  'username',
].sort();

const profileSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  bio: z.string().nullable(),
  followerCount: z.number(),
  followingCount: z.number(),
});

const listSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
  nextCursor: z.string().nullable(),
});

const idOf = (item: Record<string, unknown>): string =>
  z.object({ id: z.string() }).parse(item).id;

type RawFollow = {
  _id: string;
  followerId: string;
  followingId: string;
  createdAt: Date;
};

vi.setConfig({ testTimeout: 30_000 });

describe('Profile and follow flows (e2e)', () => {
  let e2e: E2eApp;
  let me: User;
  let token: string;

  const server = () => e2e.app.getHttpServer();
  const users = () => e2e.mongo.connection.model<User>(User.name);
  const follows = () => e2e.mongo.connection.model<Follow>(Follow.name);
  const notifications = () =>
    e2e.mongo.connection.model<Notification>(Notification.name);

  const patchMe = (body: Record<string, unknown>) =>
    request(server())
      .patch('/api/v1/profiles/me')
      .auth(token, { type: 'bearer' })
      .send(body);
  const follow = (id: string, as: string = token) =>
    request(server())
      .put(`/api/v1/profiles/${id}/follow`)
      .auth(as, { type: 'bearer' });
  const unfollow = (id: string, as: string = token) =>
    request(server())
      .delete(`/api/v1/profiles/${id}/follow`)
      .auth(as, { type: 'bearer' });
  const profile = async (id: string) =>
    profileSchema.parse(
      (await request(server()).get(`/api/v1/profiles/${id}`).expect(200)).body,
    );

  const insertFollow = (followerId: string, followingId: string, at: Date) =>
    e2e.mongo.connection.collection<RawFollow>('follows').insertOne({
      _id: randomUUID(),
      followerId,
      followingId,
      createdAt: at,
    });

  beforeAll(async () => {
    e2e = await createE2eApp('profiles_flows_e2e');
  });

  beforeEach(async () => {
    await e2e.mongo.withTransaction((session) =>
      users().deleteMany({}, { session }).exec(),
    );
    me = await createUser(e2e.mongo, { username: 'profile.me' });
    token = await e2e.sign(me);
  });

  afterAll(async () => {
    await e2e.close();
  });

  describe('PATCH /profiles/me', () => {
    it('requires a signed-in user', async () => {
      await request(server())
        .patch('/api/v1/profiles/me')
        .send({ fullName: 'Guest' })
        .expect(401);
    });

    it('trims the full name before storing it', async () => {
      const response = await patchMe({ fullName: '  An Nguyễn  ' }).expect(200);

      expect(profileSchema.parse(response.body).fullName).toBe('An Nguyễn');
    });

    it('rejects a whitespace-only full name', async () => {
      await patchMe({ fullName: '   ' }).expect(400);
    });

    it('accepts a 100-character full name and rejects 101', async () => {
      await patchMe({ fullName: 'a'.repeat(100) }).expect(200);
      await patchMe({ fullName: 'a'.repeat(101) }).expect(400);
    });

    it('applies the 100-character limit to the trimmed full name', async () => {
      const response = await patchMe({ fullName: ` ${'a'.repeat(100)} ` });

      expect(response.status).toBe(200);
    });

    it('clears the bio with an empty string and trims a non-empty one', async () => {
      await patchMe({ bio: '  Thích nấu món chay  ' }).expect(200);
      expect((await profile(me.id)).bio).toBe('Thích nấu món chay');

      await patchMe({ bio: '' }).expect(200);
      expect((await profile(me.id)).bio).toBeNull();
    });

    it('rejects a null bio with 400 instead of crashing', async () => {
      const response = await patchMe({ bio: null });

      expect(response.status).toBe(400);
    });

    it('ignores a null full name and keeps the stored one', async () => {
      const response = await patchMe({ fullName: null });

      expect(response.status).toBeLessThan(500);
      expect((await profile(me.id)).fullName).toBe(me.fullName);
    });

    it('rejects a 501-character bio', async () => {
      await patchMe({ bio: 'b'.repeat(501) }).expect(400);
    });

    it.each([
      ['username', { username: 'renamed' }],
      ['email', { email: 'x@vedora.test' }],
      ['isProfessional', { isProfessional: true }],
      ['role', { role: 'ADMIN' }],
    ])('rejects the undeclared field %s', async (_field, body) => {
      await patchMe(body).expect(400);
    });
  });

  describe('GET /profiles/:id', () => {
    it('hides an unverified account from guests', async () => {
      const pending = await createUser(e2e.mongo, {
        status: AccountStatus.PENDING_EMAIL,
        emailVerifiedAt: null,
      });

      await request(server()).get(`/api/v1/profiles/${pending.id}`).expect(404);
    });

    it('answers 404 for an unknown id and 400 for a malformed one', async () => {
      await request(server())
        .get(`/api/v1/profiles/${randomUUID()}`)
        .expect(404);
      await request(server()).get('/api/v1/profiles/not-a-uuid').expect(400);
    });
  });

  describe('follow / unfollow', () => {
    it('updates both counts and the relationship on follow and unfollow', async () => {
      const other = await createUser(e2e.mongo);

      await follow(other.id).expect(204);
      expect(await profile(other.id)).toMatchObject({ followerCount: 1 });
      expect(await profile(me.id)).toMatchObject({ followingCount: 1 });
      const following = await request(server())
        .get(`/api/v1/profiles/${other.id}/relationship`)
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(following.body).toEqual({ isFollowing: true });

      await unfollow(other.id).expect(204);
      expect(await profile(other.id)).toMatchObject({ followerCount: 0 });
      const notFollowing = await request(server())
        .get(`/api/v1/profiles/${other.id}/relationship`)
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(notFollowing.body).toEqual({ isFollowing: false });
    });

    it('creates one follow and one notification for parallel follow requests', async () => {
      const other = await createUser(e2e.mongo);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => follow(other.id)),
      );

      expect(results.map((result) => result.status)).toEqual(
        Array.from({ length: 5 }, () => 204),
      );
      expect(
        await follows().countDocuments({
          followerId: me.id,
          followingId: other.id,
        }),
      ).toBe(1);
      expect(
        await notifications().countDocuments({
          recipientId: other.id,
          actorId: me.id,
          type: NotificationType.FOLLOW,
        }),
      ).toBe(1);
    });

    it('does not notify again for a repeated follow', async () => {
      const other = await createUser(e2e.mongo);
      await follow(other.id).expect(204);

      await follow(other.id).expect(204);

      expect(
        await notifications().countDocuments({
          recipientId: other.id,
          type: NotificationType.FOLLOW,
        }),
      ).toBe(1);
    });

    it('treats unfollowing someone you never followed as success', async () => {
      const other = await createUser(e2e.mongo);

      await unfollow(other.id).expect(204);
    });

    it('answers 404 when following an unverified account and stores nothing', async () => {
      const pending = await createUser(e2e.mongo, {
        status: AccountStatus.PENDING_EMAIL,
        emailVerifiedAt: null,
      });

      await follow(pending.id).expect(404);

      expect(await follows().countDocuments({ followingId: pending.id })).toBe(
        0,
      );
    });

    it('answers 404 when following or unfollowing an unknown account', async () => {
      const ghost = randomUUID();

      await follow(ghost).expect(404);
      await unfollow(ghost).expect(404);
    });

    it('refuses follow requests from a suspended account', async () => {
      const other = await createUser(e2e.mongo);
      await users().updateOne(
        { _id: me.id },
        { status: AccountStatus.SUSPENDED },
      );

      await follow(other.id).expect(401);
    });

    it('reports isFollowing false for your own profile', async () => {
      const response = await request(server())
        .get(`/api/v1/profiles/${me.id}/relationship`)
        .auth(token, { type: 'bearer' })
        .expect(200);

      expect(response.body).toEqual({ isFollowing: false });
    });

    it('removes follows when the followed account is deleted', async () => {
      const other = await createUser(e2e.mongo);
      await follow(other.id).expect(204);

      await e2e.mongo.withTransaction((session) =>
        users().deleteOne({ _id: other.id }, { session }).exec(),
      );

      expect(await profile(me.id)).toMatchObject({ followingCount: 0 });
    });
  });

  describe('followers / following lists', () => {
    const followers = (id: string, query = '') =>
      request(server()).get(`/api/v1/profiles/${id}/followers${query}`);

    it('walks every follower newest first, one page at a time, without repeats', async () => {
      const followed = await createUser(e2e.mongo);
      const fans: User[] = [];
      for (let index = 0; index < 4; index += 1) {
        const fan = await createUser(e2e.mongo);
        fans.push(fan);
        await insertFollow(
          fan.id,
          followed.id,
          new Date(Date.UTC(2026, 0, index + 1)),
        );
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const query: string = cursor ? `?limit=1&cursor=${cursor}` : '?limit=1';
        const body = listSchema.parse(
          (await followers(followed.id, query).expect(200)).body,
        );
        for (const item of body.items) seen.push(idOf(item));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }

      const newestFirst = fans.map((fan) => fan.id).reverse();
      expect(seen).toEqual(newestFirst);
    });

    it('still reaches older verified followers when an unverified follower sits in the page', async () => {
      const followed = await createUser(e2e.mongo);
      const oldest = await createUser(e2e.mongo);
      const hidden = await createUser(e2e.mongo, {
        status: AccountStatus.PENDING_EMAIL,
        emailVerifiedAt: null,
      });
      const newest = await createUser(e2e.mongo);
      await insertFollow(
        oldest.id,
        followed.id,
        new Date(Date.UTC(2026, 0, 1)),
      );
      await insertFollow(
        hidden.id,
        followed.id,
        new Date(Date.UTC(2026, 0, 2)),
      );
      await insertFollow(
        newest.id,
        followed.id,
        new Date(Date.UTC(2026, 0, 3)),
      );

      const first = listSchema.parse(
        (await followers(followed.id, '?limit=1').expect(200)).body,
      );
      expect(first.items.map(idOf)).toEqual([newest.id]);
      const seen = first.items.map(idOf);
      if (first.nextCursor) {
        const second = listSchema.parse(
          (
            await followers(
              followed.id,
              `?limit=1&cursor=${first.nextCursor}`,
            ).expect(200)
          ).body,
        );
        seen.push(...second.items.map(idOf));
        if (second.nextCursor) {
          const third = listSchema.parse(
            (
              await followers(
                followed.id,
                `?limit=1&cursor=${second.nextCursor}`,
              ).expect(200)
            ).body,
          );
          seen.push(...third.items.map(idOf));
        }
      }

      expect(seen).toEqual([newest.id, oldest.id]);
    });

    it('returns only public summary fields for each follower', async () => {
      const followed = await createUser(e2e.mongo);
      await follow(followed.id).expect(204);

      const body = listSchema.parse(
        (await followers(followed.id).expect(200)).body,
      );

      expect(body.items).toHaveLength(1);
      expect(Object.keys(body.items[0]).sort()).toEqual(PROFILE_SUMMARY_KEYS);
    });

    it('returns an empty page for a cursor that is not in the list', async () => {
      const followed = await createUser(e2e.mongo);
      await follow(followed.id).expect(204);

      const body = listSchema.parse(
        (await followers(followed.id, `?cursor=${randomUUID()}`).expect(200))
          .body,
      );

      expect(body).toEqual({ items: [], nextCursor: null });
    });

    it.each(['?limit=0', '?limit=51', '?cursor=not-a-uuid', '?limit=abc'])(
      'rejects the query %s with 400',
      async (query) => {
        const followed = await createUser(e2e.mongo);

        await followers(followed.id, query).expect(400);
      },
    );

    it('lists who an account follows', async () => {
      const other = await createUser(e2e.mongo);
      await follow(other.id).expect(204);

      const body = listSchema.parse(
        (
          await request(server())
            .get(`/api/v1/profiles/${me.id}/following`)
            .expect(200)
        ).body,
      );

      expect(body.items.map(idOf)).toEqual([other.id]);
    });

    it('answers 404 for the followers of an unverified account', async () => {
      const pending = await createUser(e2e.mongo, {
        status: AccountStatus.PENDING_EMAIL,
        emailVerifiedAt: null,
      });

      await followers(pending.id).expect(404);
    });
  });
});
