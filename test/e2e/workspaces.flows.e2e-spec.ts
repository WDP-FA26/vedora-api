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
  WorkspaceProofKind,
} from '@src/mongo/models.js';
import { RefreshTokensService } from '@src/auth/refresh-tokens.service.js';
import { StorageService } from '@src/storage/storage.service.js';
import { WorkspacesService } from '@src/workspaces/workspaces.service.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createUser } from '@test/support/fixtures.js';
import {
  APPROVE_REVIEW,
  PAGE_APPLICATION,
  uploadedProofs,
} from '@test/support/workspace-application.js';

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
  proofs: z.array(z.object({ kind: z.string() })),
  owner: z.object({ id: z.string() }),
  legal: z.object({ taxCode: z.string() }).nullable(),
  warnings: z.array(
    z.object({
      code: z.string(),
      workspaces: z.array(z.object({ id: z.string() })),
    }),
  ),
});

const APPLICATION = PAGE_APPLICATION;

/** What an individual seller sends: no business licence. */
const IDENTITY_AND_STOREFRONT = [
  WorkspaceProofKind.ID_FRONT,
  WorkspaceProofKind.ID_BACK,
  WorkspaceProofKind.STOREFRONT,
];

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

  /** Applies with a fresh set of uploaded proofs and checks the response status. */
  const apply = async (
    token: string,
    applicantId: string,
    status: number,
    body = {},
  ) => {
    const proofIds = await uploadedProofs(e2e.mongo, applicantId);
    return request(server())
      .post('/api/v1/workspaces')
      .auth(token, { type: 'bearer' })
      .send({ ...APPLICATION, proofIds, ...body })
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
    await review(applied.id, APPROVE_REVIEW).expect(200);
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
      expect(application.proofs.map(({ kind }) => kind)).toEqual([
        'ID_FRONT',
        'ID_BACK',
        'STOREFRONT',
        'BUSINESS_LICENSE',
      ]);
      expect(application.owner.id).toBe(owner.id);

      const approved = await review(applied.id, APPROVE_REVIEW).expect(200);
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

    it("shows admins the tax department's record of a company tax code", async () => {
      const applied = workspaceSchema.parse(
        (await apply(ownerToken, owner.id, 201)).body,
      );
      const url = `/api/v1/admin/workspaces/${applied.id}/tax-code`;
      await request(server())
        .get(url)
        .auth(ownerToken, { type: 'bearer' })
        .expect(403);

      // The public source is never called from tests.
      const lookup = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({
          code: '00',
          data: {
            id: '0123456789',
            name: 'HỘ KINH DOANH CHAY AN LẠC',
            address: '12 Hàng Bông, Hà Nội',
            status: 'NNT đang hoạt động',
          },
        }),
      );
      try {
        const response = await request(server())
          .get(url)
          .auth(adminToken, { type: 'bearer' })
          .expect(200);
        expect(response.body).toMatchObject({
          status: 'FOUND',
          taxCode: '0123456789',
          officialName: 'HỘ KINH DOANH CHAY AN LẠC',
          taxStatus: 'NNT đang hoạt động',
          nameMatches: true,
        });
        expect(lookup).toHaveBeenCalledWith(
          expect.stringMatching(/\/0123456789$/),
          expect.anything(),
        );
      } finally {
        lookup.mockRestore();
      }
    });

    it('rejects with a reason, then accepts a resubmission', async () => {
      const applied = workspaceSchema.parse(
        (await apply(ownerToken, owner.id, 201)).body,
      );
      await review(applied.id, { decision: 'REJECTED' }).expect(400);
      await review(applied.id, {
        decision: 'REJECTED',
        rejectReason: 'OTHER',
      }).expect(400);
      await review(applied.id, {
        decision: 'REJECTED',
        rejectReason: 'BLURRY_DOCUMENTS',
        note: 'Ảnh giấy phép bị mờ',
      }).expect(200);

      const resubmitted = await request(server())
        .post(`/api/v1/workspaces/${applied.id}/resubmit`)
        .auth(ownerToken, { type: 'bearer' })
        .send({
          ...APPLICATION,
          proofIds: await uploadedProofs(e2e.mongo, owner.id),
        })
        .expect(200);
      expect(workspaceSchema.parse(resubmitted.body).status).toBe(
        VerificationStatus.PENDING,
      );
      const detail = await request(server())
        .get(`/api/v1/admin/workspaces/${applied.id}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(200);
      const parsed = adminDetailSchema.parse(detail.body);
      expect(parsed.proofs).toHaveLength(8);
      expect(parsed.legal?.taxCode).toBe('0123456789');
    });

    it('keeps one pending application per person and usernames unique', async () => {
      const first = workspaceSchema.parse(
        (await apply(ownerToken, owner.id, 201)).body,
      );
      expect(first.status).toBe(VerificationStatus.PENDING);

      const second = await apply(ownerToken, owner.id, 409, {
        username: 'another.page',
      });
      expect(errorSchema.parse(second.body).code).toBe('APPLICATION_PENDING');

      const clash = await apply(managerToken, manager.id, 409);
      expect(errorSchema.parse(clash.body).code).toBe('USERNAME_TAKEN');

      const taken = await apply(managerToken, manager.id, 409, {
        username: stranger.username,
      });
      expect(errorSchema.parse(taken.body).code).toBe('USERNAME_TAKEN');
    });

    it('requires the documents and tax code format of each legal form', async () => {
      const individual = {
        username: 'xe.che.chay',
        legal: {
          entityType: 'INDIVIDUAL',
          taxCode: '001203004005',
          legalAddress: '5 Lý Thường Kiệt, Hà Nội',
          representativeName: 'Trần Thị Bình',
          contactEmail: 'binh@example.com',
        },
      };
      // No business licence is needed without a registered business.
      const proofIds = await uploadedProofs(
        e2e.mongo,
        owner.id,
        IDENTITY_AND_STOREFRONT,
      );
      const created = await request(server())
        .post('/api/v1/workspaces')
        .auth(ownerToken, { type: 'bearer' })
        .send({ ...APPLICATION, ...individual, proofIds })
        .expect(201);
      expect(workspaceSchema.parse(created.body).status).toBe('PENDING');

      // A household without its licence is turned away.
      const noLicence = await request(server())
        .post('/api/v1/workspaces')
        .auth(managerToken, { type: 'bearer' })
        .send({
          ...APPLICATION,
          proofIds: await uploadedProofs(
            e2e.mongo,
            manager.id,
            IDENTITY_AND_STOREFRONT,
          ),
        })
        .expect(400);
      expect(errorSchema.parse(noLicence.body).code).toBe('MISSING_PROOF');

      for (const legal of [
        {
          ...APPLICATION.legal,
          entityType: 'COMPANY',
          taxCode: '001203004005',
        },
        { ...individual.legal, taxCode: '0123456789' },
        // 099 is no province's code.
        { ...individual.legal, taxCode: '099203004005' },
        // A household's 12-digit tax code is a citizen ID too; 9 is a birth after 2100.
        { ...APPLICATION.legal, taxCode: '001903004005' },
        { ...APPLICATION.legal, legalName: '' },
      ])
        await request(server())
          .post('/api/v1/workspaces')
          .auth(managerToken, { type: 'bearer' })
          .send({
            ...APPLICATION,
            legal,
            proofIds: await uploadedProofs(e2e.mongo, manager.id),
          })
          .expect(400);

      for (const missing of [
        { confirmsAccuracy: false },
        { consentsToReview: undefined },
        { phone: '' },
        { provinceCode: 'ha-noi' },
        { wardCode: '25747' },
        { wardCode: '4' },
      ])
        await request(server())
          .post('/api/v1/workspaces')
          .auth(managerToken, { type: 'bearer' })
          .send({
            ...APPLICATION,
            ...missing,
            proofIds: await uploadedProofs(e2e.mongo, manager.id),
          })
          .expect(400);
    });

    it('needs a full checklist to approve and warns about look-alike pages', async () => {
      const { workspaceId } = await approvedPage();

      // The same household opens a second page next door.
      const second = workspaceSchema.parse(
        (await apply(ownerToken, owner.id, 201, { username: 'an.lac.2' })).body,
      );
      const detail = await request(server())
        .get(`/api/v1/admin/workspaces/${second.id}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(200);
      const warnings = adminDetailSchema.parse(detail.body).warnings;
      expect(warnings.map(({ code }) => code).sort()).toEqual([
        'NEARBY_PAGE',
        'SAME_TAX_CODE',
      ]);
      expect(warnings[0].workspaces[0].id).toBe(workspaceId);

      await review(second.id, { decision: 'APPROVED' }).expect(400);
      const partial = await review(second.id, {
        ...APPROVE_REVIEW,
        checklist: { ...APPROVE_REVIEW.checklist, phoneConfirmed: false },
      }).expect(400);
      expect(errorSchema.parse(partial.body).code).toBe('CHECKLIST_INCOMPLETE');
      await review(second.id, APPROVE_REVIEW).expect(200);
    });

    it('stores the official ward name and maps old province slugs', async () => {
      const applied = workspaceSchema.parse(
        (await apply(ownerToken, owner.id, 201)).body,
      );
      const stored = await model<Workspace>(Workspace.name)
        .findOne({ _id: applied.id })
        .exec();
      expect(stored).toMatchObject({
        provinceCode: '01',
        wardCode: '00004',
        ward: 'Phường Ba Đình',
      });

      await model<Workspace>(Workspace.name).updateOne(
        { _id: applied.id },
        { $set: { provinceCode: 'ho-chi-minh' } },
      );
      const workspaces = e2e.app.get(WorkspacesService);
      await workspaces.remapLegacyProvinceCodes();
      await workspaces.remapLegacyProvinceCodes();
      const remapped = await model<Workspace>(Workspace.name)
        .findOne({ _id: applied.id })
        .exec();
      expect(remapped?.provinceCode).toBe('79');
    });

    it('locks the address and pin of an approved page', async () => {
      const { workspaceId } = await approvedPage();
      const details = {
        address: APPLICATION.address,
        longitude: APPLICATION.longitude,
        latitude: APPLICATION.latitude,
        phone: '0988 000 111',
        website: null,
      };
      await request(server())
        .patch(`/api/v1/workspaces/${workspaceId}/details`)
        .auth(ownerToken, { type: 'bearer' })
        .send(details)
        .expect(200);
      const moved = await request(server())
        .patch(`/api/v1/workspaces/${workspaceId}/details`)
        .auth(ownerToken, { type: 'bearer' })
        .send({ ...details, latitude: 10.77 })
        .expect(409);
      expect(errorSchema.parse(moved.body).code).toBe('LOCKED_AFTER_APPROVAL');
    });

    it('shows the legal details to the owner only', async () => {
      const { workspaceId } = await approvedPage();
      await addManager(workspaceId);
      const legalOf = async (token: string) =>
        z
          .object({ legal: z.object({ taxCode: z.string() }).nullable() })
          .parse(
            (
              await request(server())
                .get(`/api/v1/workspaces/${workspaceId}`)
                .auth(token, { type: 'bearer' })
                .expect(200)
            ).body,
          ).legal;
      expect(await legalOf(ownerToken)).not.toBeNull();
      expect(await legalOf(managerToken)).toBeNull();
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
        () => request(server()).get('/api/v1/dietary/me'),
        () =>
          request(server()).put('/api/v1/dietary/me').send({ allergies: [] }),
        () => request(server()).get('/api/v1/dietary/nutrition'),
        () =>
          request(server())
            .put('/api/v1/dietary/nutrition')
            .send({ heightCm: 165, weightKg: 60 }),
        () =>
          request(server())
            .post('/api/v1/dietary/nutrition/check-in')
            .send({ weightKg: 60 }),
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
    it('lists approved restaurants everywhere or filtered by viewport', async () => {
      const { pageUserId } = await approvedPage();
      await apply(managerToken, manager.id, 201, {
        username: 'pending.page',
      });

      const all = await request(server())
        .get('/api/v1/restaurants')
        .expect(200);
      expect(all.body).toMatchObject({
        truncated: false,
        items: [{ pageUserId, username: APPLICATION.username }],
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

      // Partial viewport bounds fail validation with 400.
      await request(server())
        .get('/api/v1/restaurants')
        .query({ minLng: 105.7, maxLng: 106 })
        .expect(400);
    });
  });
});
