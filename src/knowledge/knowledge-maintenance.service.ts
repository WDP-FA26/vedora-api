import { runtimeConfig } from '../config/runtime-config.js';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  KnowledgeDocument,
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
} from '../mongo/models.js';
import { UPLOAD_TTL_SECONDS } from '../storage/storage.service.js';

const EVENT_GRACE_MS =
  runtimeConfig.KNOWLEDGE_UPLOAD_EVENT_GRACE_SECONDS * 1000;
const STALE_PROCESSING_MS =
  runtimeConfig.KNOWLEDGE_STALE_PROCESSING_SECONDS * 1000;

@Injectable()
export class KnowledgeMaintenanceService {
  private readonly logger = new Logger(KnowledgeMaintenanceService.name);

  constructor(
    @InjectModel(KnowledgeDocument.name)
    private readonly documents: Model<KnowledgeDocument>,
  ) {}

  @Cron(runtimeConfig.KNOWLEDGE_MAINTENANCE_CRON)
  async failIncomplete(): Promise<void> {
    const now = Date.now();
    const expired = await this.documents
      .updateMany(
        {
          status: KnowledgeDocumentStatus.WAITING_UPLOAD,
          createdAt: {
            $lt: new Date(now - UPLOAD_TTL_SECONDS * 1000 - EVENT_GRACE_MS),
          },
        },
        {
          $set: {
            status: KnowledgeDocumentStatus.FAILED,
            failureReason: KnowledgeDocumentFailureReason.UPLOAD_EXPIRED,
          },
        },
      )
      .exec();
    const stale = await this.documents
      .updateMany(
        {
          status: KnowledgeDocumentStatus.PROCESSING,
          updatedAt: { $lt: new Date(now - STALE_PROCESSING_MS) },
        },
        {
          $set: {
            status: KnowledgeDocumentStatus.FAILED,
            failureReason: KnowledgeDocumentFailureReason.EXTRACTION_FAILED,
          },
        },
      )
      .exec();
    const stuckIndexing = await this.documents
      .updateMany(
        {
          status: KnowledgeDocumentStatus.INDEXING,
          updatedAt: { $lt: new Date(now - STALE_PROCESSING_MS) },
        },
        {
          $set: {
            status: KnowledgeDocumentStatus.AWAITING_REVIEW,
            failureReason: KnowledgeDocumentFailureReason.INDEXING_FAILED,
            reviewedById: null,
            reviewedAt: null,
            reviewNote: null,
          },
        },
      )
      .exec();
    if (stuckIndexing.modifiedCount > 0) {
      this.logger.log(
        `Returned ${stuckIndexing.modifiedCount} interrupted indexing runs to review`,
      );
    }
    if (expired.modifiedCount + stale.modifiedCount > 0) {
      this.logger.log(
        `Failed ${expired.modifiedCount} uploads without an upload event and ${stale.modifiedCount} interrupted extractions`,
      );
    }
  }
}
