import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import type { ClientSession, Model } from 'mongoose';
import { runtimeConfig } from '../../config/runtime-config.js';
import { InvalidInputException } from '../../common/exceptions/invalid-input.exception.js';
import { QuotaReachedException } from '../../common/exceptions/quota-reached.exception.js';
import { UnsupportedFileTypeException } from '../../common/exceptions/unsupported-file-type.exception.js';
import { FileTooLargeException } from '../../common/exceptions/file-too-large.exception.js';
import { PostReportEvidence } from '../../mongo/models.js';
import {
  StorageService,
  StorageTarget,
} from '../../storage/storage.service.js';
import type { PostReportEvidenceDto } from '../dto/post-interaction.dto.js';

export const REPORT_EVIDENCE_MAX_BYTES =
  runtimeConfig.REPORT_EVIDENCE_MAX_MB * 1048576;
export interface EvidenceFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}
const PREFIX = 'post-report-evidence/';

/** Recognize the supported raster formats from their bytes, not the supplied file name. */
function imageType(bytes: Buffer): string | null {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

@Injectable()
export class PostReportEvidenceService {
  private readonly logger = new Logger(PostReportEvidenceService.name);
  constructor(
    @InjectModel(PostReportEvidence.name)
    private readonly images: Model<PostReportEvidence>,
    private readonly storage: StorageService,
  ) {}
  private cutoff() {
    return new Date(
      Date.now() - runtimeConfig.REPORT_EVIDENCE_CLEANUP_AGE_SECONDS * 1000,
    );
  }

  async upload(ownerId: string, postId: string, file?: EvidenceFile) {
    if (!file || !file.size)
      throw new InvalidInputException('BAD_REQUEST', 'An image is required');
    if (file.size > REPORT_EVIDENCE_MAX_BYTES)
      throw new FileTooLargeException(
        'FILE_TOO_LARGE',
        'Image exceeds the configured size limit',
      );
    const contentType = imageType(file.buffer);
    if (!contentType || contentType !== file.mimetype)
      throw new UnsupportedFileTypeException(
        'UNSUPPORTED_FILE_TYPE',
        'Use a JPG, PNG or WebP image matching its content type',
      );
    if (
      (await this.images.countDocuments({ ownerId, reportId: null })) >=
      runtimeConfig.REPORT_EVIDENCE_MAX_PENDING_UPLOADS
    )
      throw new QuotaReachedException(
        'ATTACHMENT_LIMIT_REACHED',
        'Too many unsent images',
      );
    const id = randomUUID();
    const storageKey = PREFIX + ownerId + '/' + id;
    // No signed PUT is exposed: once accepted, these bytes cannot be overwritten by the browser.
    await this.storage.putBytes(
      StorageTarget.Support,
      storageKey,
      file.buffer,
      contentType,
    );
    try {
      await this.images.create({
        _id: id,
        ownerId,
        postId,
        storageKey,
        contentType,
        sizeBytes: file.size,
      });
    } catch (error) {
      await this.storage
        .delete(StorageTarget.Support, storageKey)
        .catch(() =>
          this.logger.warn('Could not remove untracked report evidence ' + id),
        );
      throw error;
    }
    return { id };
  }

  async attach(
    session: ClientSession,
    ownerId: string,
    postId: string,
    reportId: string,
    ids: readonly string[],
  ) {
    if (!ids.length) return;
    const result = await this.images
      .updateMany(
        {
          _id: { $in: [...ids] },
          ownerId,
          postId,
          reportId: null,
          createdAt: { $gte: this.cutoff() },
        },
        { $set: { reportId } },
        { session },
      )
      .exec();
    if (result.modifiedCount !== ids.length)
      throw new InvalidInputException(
        'UNKNOWN_ATTACHMENT',
        'Evidence must be your own unused uploads for this post',
      );
  }

  async forReports(ids: readonly string[]) {
    const byReport = new Map<string, PostReportEvidenceDto[]>();
    if (!ids.length) return byReport;
    const rows = await this.images
      .find({ reportId: { $in: [...ids] } })
      .sort({ createdAt: 1, _id: 1 })
      .exec();
    await Promise.all(
      rows.map(async (row) => {
        if (!row.reportId) return;
        const url = await this.storage.presignDownload(
          StorageTarget.Support,
          row.storageKey,
          runtimeConfig.REPORT_EVIDENCE_URL_TTL_SECONDS,
        );
        const list = byReport.get(row.reportId) ?? [];
        list.push({
          id: row.id,
          url,
          contentType: row.contentType,
          sizeBytes: row.sizeBytes,
        });
        byReport.set(row.reportId, list);
      }),
    );
    return byReport;
  }

  @Cron(runtimeConfig.REPORT_EVIDENCE_CLEANUP_CRON)
  async purgeUnsent() {
    if (!this.storage.isConfigured()) return;
    const stale = await this.images
      .find({ reportId: null, createdAt: { $lt: this.cutoff() } })
      .limit(runtimeConfig.REPORT_EVIDENCE_CLEANUP_BATCH_SIZE)
      .exec();
    for (const row of stale) {
      try {
        await this.storage.delete(StorageTarget.Support, row.storageKey);
        await this.images.deleteOne({ _id: row.id, reportId: null }).exec();
      } catch {
        this.logger.warn('Could not purge unused report evidence ' + row.id);
      }
    }
  }
}
