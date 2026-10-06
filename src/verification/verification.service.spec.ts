import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { VerificationStatus } from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService, StorageTarget } from '../storage/storage.service';
import { VerificationService } from './verification.service';

const userId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const adminId = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
const requestId = 'b7f6f651-b0fc-43a5-b589-edbda60e5983';
const proofId = 'c2b9a8f4-6f0b-4a8b-9d53-6c3f2f1f2a11';
const storageKey = `verifications/${userId}/${proofId}.png`;
const row = {
  id: requestId,
  userId,
  statement: 'Head chef at a plant-based restaurant since 2019.',
  status: VerificationStatus.PENDING,
  reviewNote: null,
  reviewedAt: null,
  createdAt: new Date('2026-10-07T08:00:00Z'),
  _count: { proofs: 1 },
  user: {
    id: userId,
    username: 'vedora.chef',
    fullName: 'Vedora Chef',
    email: 'chef@vedora.vn',
    avatarUrl: null,
  },
};
const submission = {
  statement: row.statement,
  proofIds: [proofId],
};

describe('VerificationService', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let storage: DeepMockProxy<StorageService>;
  let service: VerificationService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    storage = mockDeep<StorageService>();
    storage.isConfigured.mockReturnValue(true);
    storage.exists.mockResolvedValue(true);
    service = new VerificationService(prisma, storage);
    prisma.$transaction.mockImplementation(((run: unknown) =>
      typeof run === 'function'
        ? (run as (tx: unknown) => unknown)(prisma)
        : Promise.all(run as Promise<unknown>[])) as never);
    prisma.verificationProof.findMany.mockResolvedValue([
      { id: proofId, ownerId: userId, requestId: null, storageKey },
    ] as never);
    prisma.verificationProof.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      isProfessional: false,
      verificationRequests: [],
    } as never);
    prisma.verificationRequest.create.mockResolvedValue({
      id: requestId,
    } as never);
    prisma.verificationRequest.findUniqueOrThrow.mockResolvedValue(
      row as never,
    );
    prisma.verificationRequest.findUnique.mockResolvedValue(row as never);
  });

  describe('createProofUpload', () => {
    const dto = { contentType: 'image/png', sizeBytes: 1024 } as const;

    it('presigns into the private bucket under the owner', async () => {
      prisma.verificationProof.count.mockResolvedValue(0);
      const { id } = await service.createProofUpload(userId, dto);
      expect(storage.presignUpload).toHaveBeenCalledWith(
        StorageTarget.Verifications,
        `verifications/${userId}/${id}.png`,
        'image/png',
        1024,
      );
    });

    it('rejects images over the size limit', async () => {
      await expect(
        service.createProofUpload(userId, {
          ...dto,
          sizeBytes: 11 * 1024 * 1024,
        }),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
    });

    it('caps unsubmitted uploads per user', async () => {
      prisma.verificationProof.count.mockResolvedValue(12);
      await expect(
        service.createProofUpload(userId, dto),
      ).rejects.toMatchObject({ status: 429 });
      expect(storage.presignUpload).not.toHaveBeenCalled();
    });
  });

  describe('submit', () => {
    it('creates a pending request and claims the proofs', async () => {
      const request = await service.submit(userId, submission);
      expect(request).toMatchObject({
        id: requestId,
        status: VerificationStatus.PENDING,
        proofCount: 1,
      });
      expect(prisma.verificationProof.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [proofId] }, ownerId: userId, requestId: null },
        data: { requestId },
      });
    });

    it("rejects proofs that are someone else's or already submitted", async () => {
      prisma.verificationProof.findMany.mockResolvedValue([]);
      await expect(service.submit(userId, submission)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects proofs that never reached storage', async () => {
      storage.exists.mockResolvedValue(false);
      await expect(service.submit(userId, submission)).rejects.toMatchObject({
        response: { code: 'PROOF_NOT_UPLOADED' },
      });
      expect(prisma.verificationRequest.create).not.toHaveBeenCalled();
    });

    it.each([
      ['ALREADY_VERIFIED', true, []],
      ['REQUEST_PENDING', false, [{ id: requestId }]],
    ])('answers %s', async (code, isProfessional, pending) => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        isProfessional,
        verificationRequests: pending,
      } as never);
      await expect(service.submit(userId, submission)).rejects.toMatchObject({
        response: { code },
      });
      expect(prisma.verificationRequest.create).not.toHaveBeenCalled();
    });
  });

  describe('review', () => {
    beforeEach(() => {
      prisma.verificationRequest.updateMany.mockResolvedValue({ count: 1 });
    });

    it('approving marks the applicant as a professional', async () => {
      await service.review(requestId, adminId, {
        decision: VerificationStatus.APPROVED,
      });
      expect(prisma.verificationRequest.updateMany).toHaveBeenCalledWith({
        where: { id: requestId, status: VerificationStatus.PENDING },
        data: expect.objectContaining({
          status: VerificationStatus.APPROVED,
          reviewedById: adminId,
        }) as unknown,
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { isProfessional: true },
      });
    });

    it('rejecting keeps the note and leaves the account alone', async () => {
      await service.review(requestId, adminId, {
        decision: VerificationStatus.REJECTED,
        note: 'The certificate is unreadable.',
      });
      expect(prisma.verificationRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: VerificationStatus.REJECTED,
            reviewNote: 'The certificate is unreadable.',
          }) as unknown,
        }),
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses a request that was already reviewed', async () => {
      prisma.verificationRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.review(requestId, adminId, {
          decision: VerificationStatus.APPROVED,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown request', async () => {
      prisma.verificationRequest.updateMany.mockResolvedValue({ count: 0 });
      prisma.verificationRequest.findUnique.mockResolvedValue(null);
      await expect(
        service.review(requestId, adminId, {
          decision: VerificationStatus.APPROVED,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('signs a short-lived read URL for each proof', async () => {
    prisma.verificationRequest.findUnique.mockResolvedValue({
      ...row,
      proofs: [{ id: proofId, storageKey }],
    } as never);
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

  it('purges unsubmitted proofs but keeps rows whose file could not be deleted', async () => {
    prisma.verificationProof.findMany.mockResolvedValue([
      { id: 'a', storageKey: 'verifications/a.png' },
      { id: 'b', storageKey: 'verifications/b.png' },
    ] as never);
    storage.delete
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce();
    await service.purgeUnusedProofs();
    expect(prisma.verificationProof.delete).toHaveBeenCalledTimes(1);
    expect(prisma.verificationProof.delete).toHaveBeenCalledWith({
      where: { id: 'b' },
    });
  });
});
