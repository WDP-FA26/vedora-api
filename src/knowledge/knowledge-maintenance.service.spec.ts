import { Test } from '@nestjs/testing';
import {
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
} from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeMaintenanceService } from './knowledge-maintenance.service';

describe('KnowledgeMaintenanceService', () => {
  let service: KnowledgeMaintenanceService;
  let prisma: DeepMockProxy<PrismaService>;

  beforeEach(async () => {
    vi.useFakeTimers({ now: new Date('2026-09-28T12:00:00Z') });
    prisma = mockDeep<PrismaService>();
    prisma.knowledgeDocument.updateMany.mockResolvedValue({ count: 0 });
    const moduleRef = await Test.createTestingModule({
      providers: [
        KnowledgeMaintenanceService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(KnowledgeMaintenanceService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails uploads whose callback never came, after token expiry and grace', async () => {
    await service.failIncomplete();

    expect(prisma.knowledgeDocument.updateMany).toHaveBeenCalledWith({
      where: {
        status: KnowledgeDocumentStatus.WAITING_UPLOAD,
        createdAt: { lt: new Date('2026-09-28T10:50:00Z') },
      },
      data: {
        status: KnowledgeDocumentStatus.FAILED,
        failureReason: KnowledgeDocumentFailureReason.UPLOAD_EXPIRED,
      },
    });
  });

  it('fails extractions interrupted for over 15 minutes', async () => {
    await service.failIncomplete();

    expect(prisma.knowledgeDocument.updateMany).toHaveBeenCalledWith({
      where: {
        status: KnowledgeDocumentStatus.PROCESSING,
        updatedAt: { lt: new Date('2026-09-28T11:45:00Z') },
      },
      data: {
        status: KnowledgeDocumentStatus.FAILED,
        failureReason: KnowledgeDocumentFailureReason.EXTRACTION_FAILED,
      },
    });
  });
});
