import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { FileTooLargeException } from '../common/exceptions/file-too-large.exception.js';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db.js';
import { createUser } from '../../test/fixtures.js';
import { MongoModule } from '../mongo/mongo.module.js';
import { MongoService } from '../mongo/mongo.service.js';
import { StorageService, StorageTarget } from '../storage/storage.service.js';
import {
  User,
  VerificationProof,
  VerificationRequest,
  VerificationStatus,
} from '../mongo/models.js';
import { VerificationService } from './verification.service.js';

const userId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const adminId = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
const requestId = 'b7f6f651-b0fc-43a5-b589-edbda60e5983';
const proofId = 'c2b9a8f4-6f0b-4a8b-9d53-6c3f2f1f2a11';
const storageKey = `verifications/${userId}/${proofId}.png`;
const statement = 'Head chef at a plant-based restaurant since 2019.';
const submission = { statement, proofIds: [proofId] };

describe('VerificationService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: VerificationService;
  const storage = {
    isConfigured: vi.fn(),
    presignUpload: vi.fn(),
    presignDownload: vi.fn(),
    exists: vi.fn(),
    delete: vi.fn(),
  };

  const users = () => db.connection.model<User>(User.name);
  const requests = () =>
    db.connection.model<VerificationRequest>(VerificationRequest.name);
  const proofs = () =>
    db.connection.model<VerificationProof>(VerificationProof.name);

  const insertProof = (fields: Record<string, unknown> = {}) =>
    proofs().create({
      _id: proofId,
      ownerId: userId,
      requestId: null,
      storageKey,
      createdAt: new Date(),
      ...fields,
    });

  const insertRequest = (fields: Record<string, unknown> = {}) =>
    requests().create({
      _id: requestId,
      userId,
      statement,
      status: VerificationStatus.PENDING,
      reviewNote: null,
      reviewedById: null,
      reviewedAt: null,
      createdAt: new Date('2026-10-07T08:00:00Z'),
      updatedAt: new Date('2026-10-07T08:00:00Z'),
      ...fields,
    });

  const makeApplicant = (fields: Record<string, unknown> = {}) =>
    createUser(db, {
      id: userId,
      username: 'vedora.chef',
      fullName: 'Vedora Chef',
      email: 'chef@vedora.vn',
      ...fields,
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('verification'))],
      providers: [
        VerificationService,
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(VerificationService);
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    storage.isConfigured.mockReturnValue(true);
    storage.exists.mockResolvedValue(true);
    storage.presignUpload.mockResolvedValue({
      url: 'https://storage/put',
      method: 'PUT',
      headers: {},
      expiresAt: new Date(),
    });
    await users().deleteMany({});
    await requests().deleteMany({});
    await proofs().deleteMany({});
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  describe('createProofUpload', () => {
    const dto = { contentType: 'image/png', sizeBytes: 1024 } as const;

    it('presigns into the private bucket under the owner', async () => {
      const { id } = await service.createProofUpload(userId, dto);

      expect(storage.presignUpload).toHaveBeenCalledWith(
        StorageTarget.Verifications,
        `verifications/${userId}/${id}.png`,
        'image/png',
        1024,
      );
      expect(await proofs().findOne({ _id: id })).toMatchObject({
        ownerId: userId,
        requestId: null,
      });
    });

    it('rejects images over the size limit', async () => {
      await expect(
        service.createProofUpload(userId, {
          ...dto,
          sizeBytes: 11 * 1024 * 1024,
        }),
      ).rejects.toBeInstanceOf(FileTooLargeException);
      expect(storage.presignUpload).not.toHaveBeenCalled();
    });

    it('caps unsubmitted uploads per user', async () => {
      for (let index = 0; index < 12; index++) {
        await insertProof({
          _id: randomUUID(),
          storageKey: `verifications/${index}.png`,
        });
      }

      await expect(
        service.createProofUpload(userId, dto),
      ).rejects.toMatchObject({ statusCode: 429 });
      expect(storage.presignUpload).not.toHaveBeenCalled();
    });

    it('does not count submitted proofs against the cap', async () => {
      for (let index = 0; index < 12; index++) {
        await insertProof({
          _id: randomUUID(),
          storageKey: `verifications/${index}.png`,
          requestId,
        });
      }

      const uploaded = await service.createProofUpload(userId, dto);
      expect(uploaded.id).toEqual(expect.any(String));
    });
  });

  describe('submit', () => {
    beforeEach(async () => {
      await makeApplicant();
    });

    it('creates a pending request and claims the proofs', async () => {
      await insertProof();

      const request = await service.submit(userId, submission);

      expect(request).toMatchObject({
        status: 'PENDING',
        proofCount: 1,
        statement,
      });
      expect(await proofs().findOne({ _id: proofId })).toMatchObject({
        requestId: request.id,
      });
    });

    it("rejects proofs that are someone else's or already submitted", async () => {
      await insertProof({ ownerId: adminId });

      await expect(service.submit(userId, submission)).rejects.toBeInstanceOf(
        InvalidInputException,
      );
      expect(await requests().countDocuments()).toBe(0);
    });

    it('rejects proofs that never reached storage', async () => {
      await insertProof();
      storage.exists.mockResolvedValue(false);

      await expect(service.submit(userId, submission)).rejects.toMatchObject({
        code: 'PROOF_NOT_UPLOADED',
      });
      expect(await requests().countDocuments()).toBe(0);
    });

    it('answers ALREADY_VERIFIED for a professional account', async () => {
      await users().updateOne(
        { _id: userId },
        { $set: { isProfessional: true } },
      );
      await insertProof();

      await expect(service.submit(userId, submission)).rejects.toMatchObject({
        code: 'ALREADY_VERIFIED',
      });
      expect(await requests().countDocuments()).toBe(0);
    });

    it('answers REQUEST_PENDING while another request waits', async () => {
      await insertProof();
      await insertRequest();

      await expect(service.submit(userId, submission)).rejects.toMatchObject({
        code: 'REQUEST_PENDING',
      });
      expect(await requests().countDocuments()).toBe(1);
      expect(await proofs().findOne({ _id: proofId })).toMatchObject({
        requestId: null,
      });
    });

    it('answers 404 for an unknown account', async () => {
      await users().deleteMany({});
      await insertProof();

      await expect(service.submit(userId, submission)).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
    });

    it('lets only one of two parallel submits claim the proofs', async () => {
      await insertProof();

      const results = await Promise.allSettled([
        service.submit(userId, submission),
        service.submit(userId, submission),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await requests().countDocuments()).toBe(1);
    });
  });

  describe('mine', () => {
    it('returns the professional flag and the latest request', async () => {
      await makeApplicant();
      await insertRequest({
        _id: randomUUID(),
        createdAt: new Date('2026-10-01T08:00:00Z'),
      });
      await insertRequest();
      await insertProof({ requestId });

      const mine = await service.mine(userId);

      expect(mine).toMatchObject({
        isProfessional: false,
        request: { id: requestId, proofCount: 1 },
      });
    });

    it('returns no request when the account never asked', async () => {
      await makeApplicant();

      await expect(service.mine(userId)).resolves.toEqual({
        isProfessional: false,
        request: null,
      });
    });
  });

  describe('findAll', () => {
    it('lists requests newest first with their applicant', async () => {
      await makeApplicant();
      await insertRequest({
        _id: randomUUID(),
        status: VerificationStatus.APPROVED,
        createdAt: new Date('2026-10-06T08:00:00Z'),
      });
      await insertRequest({ createdAt: new Date('2026-10-08T08:00:00Z') });

      const page = await service.findAll({ page: 1, limit: 20 });

      expect(page.meta.totalItems).toBe(2);
      expect(page.items.map((item) => item.id)).toEqual([
        requestId,
        expect.any(String),
      ]);
      expect(page.items[0].user).toMatchObject({
        id: userId,
        username: 'vedora.chef',
        email: 'chef@vedora.vn',
      });
    });

    it('filters by status', async () => {
      await makeApplicant();
      await insertRequest({ status: 'APPROVED' });
      await insertRequest({ _id: randomUUID(), status: 'PENDING' });

      const page = await service.findAll({
        page: 1,
        limit: 20,
        status: VerificationStatus.APPROVED,
      });

      expect(page.meta.totalItems).toBe(1);
      expect(page.items[0].id).toBe(requestId);
    });
  });

  it('signs a short-lived read URL for each proof', async () => {
    await makeApplicant();
    await insertRequest();
    await insertProof({ requestId });
    storage.presignDownload.mockResolvedValue('https://storage/signed');

    const detail = await service.findOne(requestId);

    expect(detail.proofs).toEqual([
      { id: proofId, url: 'https://storage/signed' },
    ]);
    expect(storage.presignDownload).toHaveBeenCalledWith(
      StorageTarget.Verifications,
      storageKey,
      600,
    );
  });

  it('answers 404 for an unknown request', async () => {
    await expect(service.findOne(randomUUID())).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  describe('review', () => {
    beforeEach(async () => {
      await makeApplicant();
      await insertRequest();
    });

    it('approving marks the applicant as a professional', async () => {
      const decided = await service.review(requestId, adminId, {
        decision: VerificationStatus.APPROVED,
      });

      expect(decided).toMatchObject({ status: 'APPROVED', id: requestId });
      expect(await users().findOne({ _id: userId })).toMatchObject({
        isProfessional: true,
      });
      const stored = await requests().findOne({ _id: requestId });
      expect(stored).toMatchObject({ reviewedById: adminId });
      expect(stored?.reviewedAt).toBeInstanceOf(Date);
    });

    it('rejecting keeps the note and leaves the account alone', async () => {
      await service.review(requestId, adminId, {
        decision: VerificationStatus.REJECTED,
        note: 'The certificate is unreadable.',
      });

      expect(await requests().findOne({ _id: requestId })).toMatchObject({
        status: 'REJECTED',
        reviewNote: 'The certificate is unreadable.',
      });
      expect(await users().findOne({ _id: userId })).toMatchObject({
        isProfessional: false,
      });
    });

    it('refuses a request that was already reviewed', async () => {
      await service.review(requestId, adminId, {
        decision: VerificationStatus.APPROVED,
      });

      await expect(
        service.review(requestId, adminId, {
          decision: VerificationStatus.REJECTED,
          note: 'no',
        }),
      ).rejects.toBeInstanceOf(StateConflictException);
    });

    it('answers 404 for an unknown request', async () => {
      await expect(
        service.review(randomUUID(), adminId, {
          decision: VerificationStatus.APPROVED,
        }),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });
  });

  it('purges unsubmitted proofs but keeps rows whose file could not be deleted', async () => {
    await insertProof({
      _id: 'a',
      storageKey: 'verifications/a.png',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await insertProof({
      _id: 'b',
      storageKey: 'verifications/b.png',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    storage.delete
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(undefined);

    await service.purgeUnusedProofs();

    expect(await proofs().countDocuments()).toBe(1);
    expect(await proofs().findOne({})).toMatchObject({ _id: 'a' });
  });

  it('keeps proofs that were submitted or are recent', async () => {
    await insertRequest();
    await insertProof({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      requestId,
    });
    await insertProof({
      _id: randomUUID(),
      storageKey: 'verifications/recent.png',
      createdAt: new Date(),
    });

    await service.purgeUnusedProofs();

    expect(await proofs().countDocuments()).toBe(2);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
