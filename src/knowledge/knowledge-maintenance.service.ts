import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UPLOAD_TTL_SECONDS } from '../storage/storage.service';

const EVENT_GRACE_MS = 10 * 60 * 1000;
const STALE_PROCESSING_MS = 15 * 60 * 1000;

@Injectable()
export class KnowledgeMaintenanceService {
  private readonly logger = new Logger(KnowledgeMaintenanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async failIncomplete(): Promise<void> {
    const now = Date.now();
    const expired = await this.prisma.knowledgeDocument.updateMany({
      where: {
        status: KnowledgeDocumentStatus.WAITING_UPLOAD,
        createdAt: {
          lt: new Date(now - UPLOAD_TTL_SECONDS * 1000 - EVENT_GRACE_MS),
        },
      },
      data: {
        status: KnowledgeDocumentStatus.FAILED,
        failureReason: KnowledgeDocumentFailureReason.UPLOAD_EXPIRED,
      },
    });
    const stale = await this.prisma.knowledgeDocument.updateMany({
      where: {
        status: KnowledgeDocumentStatus.PROCESSING,
        updatedAt: { lt: new Date(now - STALE_PROCESSING_MS) },
      },
      data: {
        status: KnowledgeDocumentStatus.FAILED,
        failureReason: KnowledgeDocumentFailureReason.EXTRACTION_FAILED,
      },
    });
    if (expired.count + stale.count > 0) {
      this.logger.log(
        `Failed ${expired.count} uploads without an upload event and ${stale.count} interrupted extractions`,
      );
    }
  }
}
