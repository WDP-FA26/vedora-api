import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PostReportReason, PostReportStatus, Prisma } from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import { PostReportsService } from './post-reports.service';

const postId = 'f1a2d3e4-0000-4000-8000-000000000001';
const reportId = 'f1a2d3e4-0000-4000-8000-000000000009';
const authorId = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
const reporterId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const report = {
  id: reportId,
  postId,
  reason: PostReportReason.SPAM,
  details: null,
  status: PostReportStatus.PENDING,
  createdAt: new Date('2026-10-07T08:00:00Z'),
};

describe('PostReportsService', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: PostReportsService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new PostReportsService(prisma);
    prisma.post.findFirst.mockResolvedValue({ authorId } as never);
    prisma.postReport.create.mockResolvedValue(report as never);
  });

  it('files a report against a published post', async () => {
    await expect(
      service.create(postId, reporterId, {
        reason: PostReportReason.SPAM,
        details: '',
      }),
    ).resolves.toEqual(report);
    expect(prisma.postReport.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { postId, reporterId, reason: 'SPAM', details: null },
      }),
    );
  });

  it('refuses reports on missing posts and on your own post', async () => {
    await expect(
      service.create(postId, authorId, { reason: PostReportReason.SPAM }),
    ).rejects.toBeInstanceOf(BadRequestException);

    prisma.post.findFirst.mockResolvedValue(null);
    await expect(
      service.create(postId, reporterId, { reason: PostReportReason.SPAM }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.postReport.create).not.toHaveBeenCalled();
  });

  it('answers 409 ALREADY_REPORTED for a second report', async () => {
    prisma.postReport.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.create(postId, reporterId, { reason: PostReportReason.SPAM }),
    ).rejects.toMatchObject({
      response: { code: 'ALREADY_REPORTED' },
    });
  });

  it('closes a pending report once', async () => {
    prisma.postReport.findUnique.mockResolvedValue(report as never);
    prisma.postReport.updateMany.mockResolvedValue({ count: 1 });
    await service.review(reportId, authorId, PostReportStatus.DISMISSED);
    expect(prisma.postReport.updateMany).toHaveBeenCalledWith({
      where: { id: reportId, status: PostReportStatus.PENDING },
      data: expect.objectContaining({
        status: PostReportStatus.DISMISSED,
        reviewedById: authorId,
      }) as unknown,
    });

    prisma.postReport.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.review(reportId, authorId, PostReportStatus.RESOLVED),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
