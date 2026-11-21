import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { z } from 'zod';
import {
  AccountStatus,
  AccountType,
  Follow,
  RefreshToken,
  User,
  UserRole,
  VerificationStatus,
  Workspace,
  WorkspaceMember,
  WorkspaceProof,
} from '../../src/mongo/models.js';
import { RefreshTokensService } from '../../src/auth/refresh-tokens.service.js';
import { StorageService } from '../../src/storage/storage.service.js';
import { createE2eApp, type E2eApp } from '../support/e2e-app.js';
import { createUser } from '../support/fixtures.js';

/**
 * Black-box flows for restaurant pages (/workspaces): an owner applies with
 * proofs, an admin approves, members switch into the page and act as it.
 * Object storage (RustFS) is the only faked boundary.
 */

const workspaceSchema = z.object({
  id: z.string(),
  pageUserId: z.string().nullable(),
  username: z.string(),
  status: z.enum(VerificationStatus),
  role: z.enum(['OWNER', 'MANAGER']),
  members: z.array(z.object({ userId: z.string(), role: z.string() })),
});

const sessionSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: z.object({ id: z.string(), accountType: z.enum(AccountType) }),
  actor: z.object({ id: z.string() }).nullable(),
});

const errorSchema = z.object({ statusCode: z.number(), code: z.string() });

const listSchema = z.object({ items: z.array(z.unknown()) });

const adminDetailSchema = z.object({
  pageUserId: z.string().nullable(),
  proofs: z.array(z.unknown()),
  owner: z.object({ id: z.string() }),
});

const APPLICATION = {
  name: 'Chay An Lạc',
  username: 'chay.an.lac',
  bio: 'Quán chay gia đình',
  address: '12 Hàng Bông, Hoàn Kiếm, Hà Nội',
  longitude: 105.8482,
  latitude: 21.0302,
  phone: '0901 234 567',
  website: 'https://anlac.example',
  statement: 'Tôi là chủ quán, đính kèm giấy phép kinh doanh và ảnh mặt tiền.',
};

vi.setConfig({ testTimeout: 30_000 });

describe('Restaurant page flows (e2e)', () => {
  let e2e: E2eApp;
  let owner: User;
  let manager: User;
  let stranger: User;
  let admin: User;
  let ownerToken: string;
  let managerToken: string;
  let adminToken: string;

  const server = () => e2e.app.getHttpServer();
  const model = <T>(name: string) => e2e.mongo.connection.model<T>(name);
  const users = () => model<User>(User.name);

  const uploadedProof = async (ownerId: string) => {
    const id = randomUUID();
    await model<WorkspaceProof>(WorkspaceProof.name).create({
      _id: id,
      ownerId,
      storageKey: `workspaces/${ownerId}/${id}.jpg`,
    });
    return id;
  };

  /** Applies with a fresh uploaded proof and checks the response status. */
  const apply = async (
    token: string,
    applicantId: string,
    status: number,
    body = {},
  ) => {
    const proofId = await uploadedProof(applicantId);
    return request(server())
      .post('/api/v1/workspaces')
      .auth(token, { type: 'bearer' })
      .send({
        ...APPLICATION,
        proofIds: [proofId],
        ...body,
      })
      .expect(status);
  };

  const review = (id: string, body: Record<string, unknown>) =>
    request(server())
      .post(`/api/v1/admin/workspaces/${id}/review`)
      .auth(adminToken, { type: 'bearer' })
      .send(body);

  /** An approved page owned by `owner`. */
  const approvedPage = async () => {
    const applied = workspaceSchema.parse(
      (await apply(ownerToken, owner.id, 201)).body,
    );
    await review(applied.id, { decision: 'APPROVED' }).expect(200);
    const workspace = await model<Workspace>(Workspace.name)
      .findOne({ _id: applied.id })
      .exec();
    if (!workspace?.pageUserId) throw new Error('page was not created');
    return { workspaceId: workspace.id, pageUserId: workspace.pageUserId };
  };

  /** A personal session for `user`, as a login would give. */
  const personalSession = async (user: User) => {
    const issued = await e2e.app.get(RefreshTokensService).issue(user.id);
    return { accessToken: await e2e.sign(user), refreshToken: issued.token };
  };

  const switchTo = (
    session: { accessToken: string; refreshToken: string },
    pageId: string | null,
  ) =>
    request(server())
      .post('/api/v1/auth/switch')
      .auth(session.accessToken, { type: 'bearer' })
      .send({ refreshToken: session.refreshToken, pageId });

  const addManager = (workspaceId: string) =>
    request(server())
      .post(`/api/v1/workspaces/${workspaceId}/members`)
      .auth(ownerToken, { type: 'bearer' })
      .send({ username: manager.username })
      .expect(201);

  beforeAll(async () => {
    e2e = await createE2eApp('workspaces_flows_e2e');
    const storage = e2e.app.get(StorageService);
    vi.spyOn(storage, 'exists').mockResolvedValue(true);
    vi.spyOn(storage, 'presignDownload').mockResolvedValue(
      'https://storage.test/signed',
    );
  });

  beforeEach(async () => {
    await e2e.mongo.withTransaction((session) =>
      users().deleteMany({}, { session }).exec(),
    );
    for (const name of [
      Workspace.name,
      WorkspaceMember.name,
      WorkspaceProof.name,
      RefreshToken.name,
      Follow.name,
    ])
      await model(name).deleteMany({});
    owner = await createUser(e2e.mongo, { username: 'page.owner' });
    manager = await createUser(e2e.mongo, { username: 'page.manager' });
    stranger = await createUser(e2e.mongo, { username: 'page.stranger' });
    admin = await createUser(e2e.mongo, {
      username: 'page.admin',
      role: UserRole.ADMIN,
    });
    [ownerToken, managerToken, adminToken] = await Promise.all([
      e2e.sign(owner),
      e2e.sign(manager),
      e2e.sign(admin),
    ]);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await e2e.close();
  });

  describe('applying and review', () => {
    it('keeps a pending page out of profiles until an admin approves it', async () => {
      const applied = workspaceSchema.parse(
        (await apply(ownerToken, owner.id, 201)).body,
      );
      expect(applied).toMatchObject({
        status: VerificationStatus.PENDING,
        pageUserId: null,
        role: 'OWNER',
      });
      expect(await users().exists({ username: APPLICATION.username })).toBe(
        null,
      );

      const listed = await request(server())
        .get('/api/v1/admin/workspaces?status=PENDING')
        .auth(adminToken, { type: 'bearer' })
        .expect(200);
      expect(listSchema.parse(listed.body).items).toHaveLength(1);
      const detail = await request(server())
        .get(`/api/v1/admin/workspaces/${applied.id}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(200);
      const application = adminDetailSchema.parse(detail.body);
      expect(application.proofs).toHaveLength(1);
      expect(application.owner.id).toBe(owner.id);

      const approved = await review(applied.id, {
        decision: 'APPROVED',
      }).expect(200);
      const pageUserId = z
        .string()
        .parse(
          z.object({ pageUserId: z.unknown() }).parse(approved.body).pageUserId,
        );

      const page = await users().findOne({ _id: pageUserId }).exec();
      expect(page).toMatchObject({
        username: APPLICATION.username,
        fullName: APPLICATION.name,
        accountType: AccountType.PAGE,
        status: AccountStatus.ACTIVE,
        passwordHash: null,
        googleId: null,
        role: UserRole.USER,
      });

      const profile = await request(server())
        .get(`/api/v1/profiles/${pageUserId}`)
        .expect(200);
      expect(profile.body).toMatchObject({
        accountType: AccountType.PAGE,
        restaurant: {
          address: APPLICATION.address,
          longitude: APPLICATION.longitude,
          latitude: APPLICATION.latitude,
        },
      });
    });

    it('forbids ordinary users from the admin queue', async () => {
      const response = await request(server())
        .get('/api/v1/admin/workspaces')
        .auth(ownerToken, { type: 'bearer' })
        .expect(403);
      expect(errorSchema.parse(response.body).code).toBe('FORBIDDEN');
    });

    it('rejects with a note, then accepts a resubmission', async () => {
      const applied = workspaceSchema.parse(
        (await apply(ownerToken, owner.id, 201)).body,
      );
      await review(applied.id, { decision: 'REJECTED' }).expect(400);
      await review(applied.id, {
        decision: 'REJECTED',
        note: 'Ảnh giấy phép bị mờ',
      }).expect(200);

      const resubmitted = await request(server())
        .post(`/api/v1/workspaces/${applied.id}/resubmit`)
        .auth(ownerToken, { type: 'bearer' })
        .send({
          ...APPLICATION,
          proofIds: [await uploadedProof(owner.id)],
        })
        .expect(200);
      expect(workspaceSchema.parse(resubmitted.body).status).toBe(
        VerificationStatus.PENDING,
      );
      const detail = await request(server())
        .get(`/api/v1/admin/workspaces/${applied.id}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(200);
      expect(adminDetailSchema.parse(detail.body).proofs).toHaveLength(2);
    });

    it('allows one pending application per person and unique usernames', async () => {
      await apply(ownerToken, owner.id, 201);
      const second = await apply(ownerToken, owner.id, 409, {
        username: 'another.page',
      });
      expect(errorSchema.parse(second.body).code).toBe('REQUEST_PENDING');

      const clash = await apply(managerToken, manager.id, 409);
      expect(errorSchema.parse(clash.body).code).toBe('USERNAME_TAKEN');

      const taken = await apply(managerToken, manager.id, 409, {
        username: stranger.username,
      });
      expect(errorSchema.parse(taken.body).code).toBe('USERNAME_TAKEN');
    });
  });

  describe('acting as the page', () => {
    it('switches into the page, acts as it, and switches back', async () => {
      const { pageUserId } = await approvedPage();
      const personal = await personalSession(owner);

      const switched = sessionSchema.parse(
        (await switchTo(personal, pageUserId).expect(200)).body,
      );
      expect(switched.user).toMatchObject({
        id: pageUserId,
        accountType: AccountType.PAGE,
      });
      expect(switched.actor?.id).toBe(owner.id);

      const me = await request(server())
        .get('/api/v1/auth/me')
        .auth(switched.accessToken, { type: 'bearer' })
        .expect(200);
      expect(me.body).toMatchObject({
        id: pageUserId,
        actor: { id: owner.id },
      });

      await request(server())
        .put(`/api/v1/profiles/${stranger.id}/follow`)
        .auth(switched.accessToken, { type: 'bearer' })
        .expect((response) => expect(response.status).toBeLessThan(300));
      expect(
        await model<Follow>(Follow.name)
          .exists({ followerId: pageUserId, followingId: stranger.id })
          .exec(),
      ).not.toBe(null);

      // The personal refresh token was spent on the switch.
      await request(server())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: personal.refreshToken })
        .expect(401);

      const refreshed = sessionSchema.parse(
        (
          await request(server())
            .post('/api/v1/auth/refresh')
            .send({ refreshToken: switched.refreshToken })
            .expect(200)
        ).body,
      );
      expect(refreshed.user.id).toBe(pageUserId);
      expect(refreshed.actor?.id).toBe(owner.id);

      const back = sessionSchema.parse(
        (await switchTo(refreshed, null).expect(200)).body,
      );
      expect(back.user.id).toBe(owner.id);
      expect(back.actor).toBe(null);
    });

    it('refuses to switch into a page you do not manage', async () => {
      const { pageUserId } = await approvedPage();
      const response = await switchTo(
        await personalSession(stranger),
        pageUserId,
      ).expect(403);
      expect(errorSchema.parse(response.body).code).toBe('FORBIDDEN');
    });

    it("refuses a refresh token from someone else's session", async () => {
      const { pageUserId } = await approvedPage();
      const ownerSession = await personalSession(owner);
      const strangerSession = await personalSession(stranger);
      await switchTo(
        {
          accessToken: ownerSession.accessToken,
          refreshToken: strangerSession.refreshToken,
        },
        pageUserId,
      ).expect(401);
    });

    it('keeps account-level actions out of a page session', async () => {
      const { pageUserId } = await approvedPage();
      const switched = sessionSchema.parse(
        (await switchTo(await personalSession(owner), pageUserId)).body,
      );
      const calls = [
        () => request(server()).delete(`/api/v1/users/${pageUserId}`),
        () =>
          request(server())
            .patch(`/api/v1/users/${pageUserId}`)
            .send({ fullName: 'x' }),
        () => request(server()).get('/api/v1/billing/me'),
        () => request(server()).post('/api/v1/workspaces').send(APPLICATION),
      ];
      for (const call of calls) {
        const response = await call()
          .auth(switched.accessToken, { type: 'bearer' })
          .expect(403);
        expect(errorSchema.parse(response.body).code).toBe(
          'PAGE_SESSION_NOT_ALLOWED',
        );
      }
      expect(await users().exists({ _id: pageUserId })).not.toBe(null);
    });
  });

  describe('managers', () => {
    it('ends a removed manager’s page session at once, refresh included', async () => {
      const { workspaceId, pageUserId } = await approvedPage();
      await addManager(workspaceId);
      const switched = sessionSchema.parse(
        (await switchTo(await personalSession(manager), pageUserId).expect(200))
          .body,
      );
      await request(server())
        .get('/api/v1/auth/me')
        .auth(switched.accessToken, { type: 'bearer' })
        .expect(200);

      await request(server())
        .delete(`/api/v1/workspaces/${workspaceId}/members/${manager.id}`)
        .auth(ownerToken, { type: 'bearer' })
        .expect(204);

      const denied = await request(server())
        .get('/api/v1/auth/me')
        .auth(switched.accessToken, { type: 'bearer' })
        .expect(401);
      expect(errorSchema.parse(denied.body).code).toBe('PAGE_ACCESS_REVOKED');
      await request(server())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: switched.refreshToken })
        .expect(401);
    });

    it('signs a removed manager back into their own account on refresh', async () => {
      const { workspaceId, pageUserId } = await approvedPage();
      await addManager(workspaceId);
      const switched = sessionSchema.parse(
        (await switchTo(await personalSession(manager), pageUserId)).body,
      );
      // Removed outside the API, so the page session is still live.
      await model<WorkspaceMember>(WorkspaceMember.name).deleteOne({
        workspaceId,
        userId: manager.id,
      });

      const refreshed = sessionSchema.parse(
        (
          await request(server())
            .post('/api/v1/auth/refresh')
            .send({ refreshToken: switched.refreshToken })
            .expect(200)
        ).body,
      );
      expect(refreshed.user.id).toBe(manager.id);
      expect(refreshed.actor).toBe(null);
    });

    it('ends the page session of a suspended member', async () => {
      const { workspaceId, pageUserId } = await approvedPage();
      await addManager(workspaceId);
      const switched = sessionSchema.parse(
        (await switchTo(await personalSession(manager), pageUserId)).body,
      );
      await users().updateOne(
        { _id: manager.id },
        { $set: { status: AccountStatus.SUSPENDED } },
      );

      const denied = await request(server())
        .get('/api/v1/auth/me')
        .auth(switched.accessToken, { type: 'bearer' })
        .expect(401);
      expect(errorSchema.parse(denied.body).code).toBe('ACCOUNT_SUSPENDED');
      await request(server())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: switched.refreshToken })
        .expect(401);
    });

    it('lets only the owner add or remove managers, and never removes the owner', async () => {
      const { workspaceId } = await approvedPage();
      await addManager(workspaceId);

      const added = await request(server())
        .post(`/api/v1/workspaces/${workspaceId}/members`)
        .auth(managerToken, { type: 'bearer' })
        .send({ username: stranger.username })
        .expect(403);
      expect(errorSchema.parse(added.body).code).toBe(
        'WORKSPACE_OWNER_REQUIRED',
      );

      const again = await request(server())
        .post(`/api/v1/workspaces/${workspaceId}/members`)
        .auth(ownerToken, { type: 'bearer' })
        .send({ username: manager.username })
        .expect(409);
      expect(errorSchema.parse(again.body).code).toBe('ALREADY_MEMBER');

      await request(server())
        .delete(`/api/v1/workspaces/${workspaceId}/members/${owner.id}`)
        .auth(managerToken, { type: 'bearer' })
        .expect(409);

      // A manager may leave.
      await request(server())
        .delete(`/api/v1/workspaces/${workspaceId}/members/${manager.id}`)
        .auth(managerToken, { type: 'bearer' })
        .expect(204);
      await request(server())
        .get(`/api/v1/workspaces/${workspaceId}`)
        .auth(managerToken, { type: 'bearer' })
        .expect(404);
    });
  });

  describe('restaurant map', () => {
    it('lists approved restaurants inside the viewport only', async () => {
      const { pageUserId } = await approvedPage();
      await apply(managerToken, manager.id, 201, {
        username: 'pending.page',
      });

      const hanoi = await request(server())
        .get('/api/v1/restaurants')
        .query({ minLng: 105.7, minLat: 20.9, maxLng: 106, maxLat: 21.1 })
        .expect(200);
      expect(hanoi.body).toMatchObject({
        truncated: false,
        items: [{ pageUserId, username: APPLICATION.username }],
      });

      const saigon = await request(server())
        .get('/api/v1/restaurants')
        .query({ minLng: 106.6, minLat: 10.7, maxLng: 106.8, maxLat: 10.9 })
        .expect(200);
      expect(listSchema.parse(saigon.body).items).toEqual([]);

      await request(server())
        .get('/api/v1/restaurants')
        .query({ minLng: 0, minLat: 50, maxLng: 1, maxLat: 10 })
        .expect(400);
    });
  });
});
