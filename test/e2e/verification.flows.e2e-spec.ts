import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { z } from 'zod';
import {
  User,
  UserRole,
  VerificationProof,
  VerificationRequest,
  VerificationStatus,
} from '../../src/mongo/models.js';
import { StorageService } from '../../src/storage/storage.service.js';
import { createE2eApp, type E2eApp } from '../support/e2e-app.js';
import { createUser } from '../support/fixtures.js';

/**
 * Black-box flows for the verified-chef badge (/verification): applicant
 * submits proofs, admins review, and the badge shows on the public profile.
 * Object storage (RustFS) is the only faked boundary.
 */

const requestSchema = z.object({
  id: z.string(),
  status: z.enum(VerificationStatus),
  reviewNote: z.string().nullable(),
  proofCount: z.number(),
});

const errorSchema = z
  .object({
    statusCode: z.number(),
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const STATEMENT = 'Head chef at a vegan restaurant in Hanoi since 2019.';

vi.setConfig({ testTimeout: 30_000 });

describe('Verified chef badge flows (e2e)', () => {
  let e2e: E2eApp;
  let applicant: User;
  let admin: User;
  let applicantToken: string;
  let adminToken: string;

  const server = () => e2e.app.getHttpServer();
  const users = () => e2e.mongo.connection.model<User>(User.name);
  const proofs = () =>
    e2e.mongo.connection.model<VerificationProof>(VerificationProof.name);
  const requests = () =>
    e2e.mongo.connection.model<VerificationRequest>(VerificationRequest.name);

  /** A proof row as if the presigned upload had completed. */
  const uploadedProof = async (ownerId: string) => {
    const id = randomUUID();
    await proofs().create({
      _id: id,
      ownerId,
      storageKey: `verifications/${ownerId}/${id}.jpg`,
    });
    return id;
  };

  const submit = (token: string, proofIds: string[], statement = STATEMENT) =>
    request(server())
      .post('/api/v1/verification/requests')
      .auth(token, { type: 'bearer' })
      .send({ statement, proofIds });

  const review = (id: string, body: Record<string, unknown>) =>
    request(server())
      .post(`/api/v1/verification/requests/${id}/review`)
      .auth(adminToken, { type: 'bearer' })
      .send(body);

  const submitted = async () => {
    const response = await submit(applicantToken, [
      await uploadedProof(applicant.id),
    ]).expect(201);
    return requestSchema.parse(response.body);
  };

  beforeAll(async () => {
    e2e = await createE2eApp('verification_flows_e2e');
    const storage = e2e.app.get(StorageService);
    vi.spyOn(storage, 'exists').mockResolvedValue(true);
    vi.spyOn(storage, 'presignDownload').mockResolvedValue(
      'https://storage.test/signed',
    );
    vi.spyOn(storage, 'presignUpload').mockResolvedValue({
      url: 'https://storage.test/upload',
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      expiresAt: new Date(Date.now() + 3600_000),
    });
  });

  beforeEach(async () => {
    await e2e.mongo.withTransaction((session) =>
      users().deleteMany({}, { session }).exec(),
    );
    await proofs().deleteMany({});
    await requests().deleteMany({});
    applicant = await createUser(e2e.mongo, { username: 'chef.applicant' });
    admin = await createUser(e2e.mongo, {
      username: 'chef.admin',
      role: UserRole.ADMIN,
    });
    [applicantToken, adminToken] = await Promise.all([
      e2e.sign(applicant),
      e2e.sign(admin),
    ]);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await e2e.close();
  });

  describe('authorization', () => {
    it('requires a signed-in user for your own status', async () => {
      await request(server()).get('/api/v1/verification/me').expect(401);
    });

    it.each([
      ['get', '/api/v1/verification/requests'],
      ['get', `/api/v1/verification/requests/${randomUUID()}`],
      ['post', `/api/v1/verification/requests/${randomUUID()}/review`],
    ] as const)('forbids an ordinary user from %s %s', async (method, path) => {
      const response = await request(server())
        [method](path)
        .auth(applicantToken, { type: 'bearer' })
        .send({ decision: VerificationStatus.APPROVED });

      expect(response.status).toBe(403);
      expect(errorSchema.parse(response.body).code).toBe('FORBIDDEN');
    });
  });

  describe('applicant', () => {
    it('reports no badge and no request before applying', async () => {
      const response = await request(server())
        .get('/api/v1/verification/me')
        .auth(applicantToken, { type: 'bearer' })
        .expect(200);

      expect(response.body).toEqual({ isProfessional: false, request: null });
    });

    it('creates a pending request that claims the proofs', async () => {
      const created = await submitted();

      expect(created).toMatchObject({
        status: VerificationStatus.PENDING,
        proofCount: 1,
      });
    });

    it('refuses a second request while one is pending', async () => {
      await submitted();

      const response = await submit(applicantToken, [
        await uploadedProof(applicant.id),
      ]).expect(409);

      expect(errorSchema.parse(response.body).code).toBe('REQUEST_PENDING');
    });

    it("rejects another user's proof", async () => {
      const stranger = await createUser(e2e.mongo);

      await submit(applicantToken, [await uploadedProof(stranger.id)]).expect(
        400,
      );
    });

    it('rejects a proof already used by an earlier request', async () => {
      const proofId = await uploadedProof(applicant.id);
      const first = requestSchema.parse(
        (await submit(applicantToken, [proofId]).expect(201)).body,
      );
      await review(first.id, {
        decision: VerificationStatus.REJECTED,
        note: 'Blurry photo',
      }).expect(200);

      await submit(applicantToken, [proofId]).expect(400);
    });

    it('answers PROOF_NOT_UPLOADED when a proof never reached storage', async () => {
      const storage = e2e.app.get(StorageService);
      vi.spyOn(storage, 'exists').mockResolvedValueOnce(false);

      const response = await submit(applicantToken, [
        await uploadedProof(applicant.id),
      ]).expect(409);

      expect(errorSchema.parse(response.body).code).toBe('PROOF_NOT_UPLOADED');
    });

    it.each([
      ['no proofs', [], STATEMENT],
      ['duplicate proof ids', 'dup', STATEMENT],
      ['seven proofs', 'seven', STATEMENT],
      [
        'a statement of 19 characters after trimming',
        'one',
        `   ${'s'.repeat(19)}   `,
      ],
      ['a statement over 2000 characters', 'one', 's'.repeat(2001)],
    ] as const)('rejects %s with 400', async (_case, shape, statement) => {
      let ids: string[] = [];
      if (shape === 'dup') {
        const id = await uploadedProof(applicant.id);
        ids = [id, id];
      } else if (shape === 'seven') {
        for (let index = 0; index < 7; index += 1) {
          ids.push(await uploadedProof(applicant.id));
        }
      } else if (shape === 'one') {
        ids = [await uploadedProof(applicant.id)];
      }

      await submit(applicantToken, ids, statement).expect(400);
    });

    it.each([
      [
        'an image over 10 MiB',
        { contentType: 'image/png', sizeBytes: 10 * 1024 * 1024 + 1 },
        413,
      ],
      ['a GIF', { contentType: 'image/gif', sizeBytes: 1000 }, 400],
      ['a zero-byte image', { contentType: 'image/png', sizeBytes: 0 }, 400],
    ] as const)(
      'refuses a proof upload for %s',
      async (_case, body, status) => {
        await request(server())
          .post('/api/v1/verification/proofs/uploads')
          .auth(applicantToken, { type: 'bearer' })
          .send(body)
          .expect(status);
      },
    );

    it('accepts a proof upload of exactly 10 MiB', async () => {
      await request(server())
        .post('/api/v1/verification/proofs/uploads')
        .auth(applicantToken, { type: 'bearer' })
        .send({ contentType: 'image/webp', sizeBytes: 10 * 1024 * 1024 })
        .expect(201);
    });
  });

  describe('admin review', () => {
    it('approving grants the badge on the account and the public profile', async () => {
      const created = await submitted();

      const response = await review(created.id, {
        decision: VerificationStatus.APPROVED,
      }).expect(200);

      expect(requestSchema.parse(response.body).status).toBe(
        VerificationStatus.APPROVED,
      );
      const mine = await request(server())
        .get('/api/v1/verification/me')
        .auth(applicantToken, { type: 'bearer' })
        .expect(200);
      expect(mine.body).toMatchObject({ isProfessional: true });
      const profile = await request(server())
        .get(`/api/v1/profiles/${applicant.id}`)
        .expect(200);
      expect(profile.body).toMatchObject({ isProfessional: true });
    });

    it('refuses a new request from an applicant who already has the badge', async () => {
      const created = await submitted();
      await review(created.id, {
        decision: VerificationStatus.APPROVED,
      }).expect(200);

      const response = await submit(applicantToken, [
        await uploadedProof(applicant.id),
      ]).expect(409);

      expect(errorSchema.parse(response.body).code).toBe('ALREADY_VERIFIED');
    });

    it('requires a note to reject', async () => {
      const created = await submitted();

      await review(created.id, {
        decision: VerificationStatus.REJECTED,
      }).expect(400);
      await review(created.id, {
        decision: VerificationStatus.REJECTED,
        note: '   ',
      }).expect(400);
    });

    it('rejecting keeps the account unbadged, shows the note, and allows a new request', async () => {
      const created = await submitted();

      await review(created.id, {
        decision: VerificationStatus.REJECTED,
        note: '  Need a work certificate  ',
      }).expect(200);

      const mine = await request(server())
        .get('/api/v1/verification/me')
        .auth(applicantToken, { type: 'bearer' })
        .expect(200);
      expect(mine.body).toMatchObject({
        isProfessional: false,
        request: {
          status: VerificationStatus.REJECTED,
          reviewNote: 'Need a work certificate',
        },
      });
      await submit(applicantToken, [await uploadedProof(applicant.id)]).expect(
        201,
      );
    });

    it.each([VerificationStatus.PENDING, 'MAYBE'])(
      'rejects the decision %s with 400',
      async (decision) => {
        const created = await submitted();

        await review(created.id, { decision }).expect(400);
      },
    );

    it('refuses to review the same request twice', async () => {
      const created = await submitted();
      await review(created.id, {
        decision: VerificationStatus.APPROVED,
      }).expect(200);

      const response = await review(created.id, {
        decision: VerificationStatus.REJECTED,
        note: 'Changed my mind',
      }).expect(409);

      expect(errorSchema.parse(response.body).code).toBe('CONFLICT');
    });

    it('lets exactly one of two parallel reviews decide a request', async () => {
      const created = await submitted();

      const results = await Promise.all([
        review(created.id, { decision: VerificationStatus.APPROVED }),
        review(created.id, {
          decision: VerificationStatus.REJECTED,
          note: 'Not enough proof',
        }),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    });

    it('answers 404 for an unknown request', async () => {
      await review(randomUUID(), {
        decision: VerificationStatus.APPROVED,
      }).expect(404);
    });

    it('shows the admin the applicant email and signed proof URLs, and keeps reviewer ids out of the applicant view', async () => {
      const created = await submitted();

      const detail = await request(server())
        .get(`/api/v1/verification/requests/${created.id}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(200);

      expect(detail.body).toMatchObject({
        user: { id: applicant.id, email: applicant.email },
        proofs: [{ url: 'https://storage.test/signed' }],
      });
      const mine = await request(server())
        .get('/api/v1/verification/me')
        .auth(applicantToken, { type: 'bearer' })
        .expect(200);
      expect(JSON.stringify(mine.body)).not.toContain('reviewedById');
    });
  });
});
