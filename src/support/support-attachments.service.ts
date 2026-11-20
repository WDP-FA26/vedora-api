import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import type { ClientSession, Model } from 'mongoose';
import { runtimeConfig } from '../config/runtime-config.js';
import { FileTooLargeException } from '../common/exceptions/file-too-large.exception.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { QuotaReachedException } from '../common/exceptions/quota-reached.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { SupportAttachment } from '../mongo/models.js';
import { StorageService, StorageTarget } from '../storage/storage.service.js';
import type {
  CreateSupportAttachmentUploadDto,
  SupportAttachmentDto,
  SupportAttachmentType,
  SupportAttachmentUploadDto,
} from './dto/support.dto.js';

const EXTENSIONS: Record<SupportAttachmentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_BYTES = runtimeConfig.SUPPORT_ATTACHMENT_MAX_MB * 1048576;
const CLEANUP_AGE_MS =
  runtimeConfig.SUPPORT_ATTACHMENT_CLEANUP_AGE_SECONDS * 1000;
const URL_TTL_SECONDS = runtimeConfig.SUPPORT_ATTACHMENT_URL_TTL_SECONDS;

/**
 * Images on support messages. The browser uploads to the private support
 * bucket first; a message then claims the upload by id. Downloads use
 * short-lived signed URLs, so only people who can read the message see them.
 */
@Injectable()
export class SupportAttachmentsService {
  private readonly logger = new Logger(SupportAttachmentsService.name);

  constructor(
    @InjectModel(SupportAttachment.name)
    private readonly attachments: Model<SupportAttachment>,
    private readonly storage: StorageService,
  ) {}

  async createUpload(
    ownerId: string,
    dto: CreateSupportAttachmentUploadDto,
  ): Promise<SupportAttachmentUploadDto> {
    if (dto.sizeBytes > MAX_BYTES) {
      throw new FileTooLargeException(
        'FILE_TOO_LARGE',
        `Images must be at most ${runtimeConfig.SUPPORT_ATTACHMENT_MAX_MB} MB`,
      );
    }
    const pending = await this.attachments
      .countDocuments({ ownerId, messageId: null })
      .exec();
    if (pending >= runtimeConfig.SUPPORT_MAX_UNATTACHED_UPLOADS) {
      throw new QuotaReachedException(
        'ATTACHMENT_LIMIT_REACHED',
        'Too many images waiting to be sent; try again later',
      );
    }

    const id = randomUUID();
    const key = `support/${ownerId}/${id}.${EXTENSIONS[dto.contentType]}`;
    const upload = await this.storage.presignUpload(
      StorageTarget.Support,
      key,
      dto.contentType,
      dto.sizeBytes,
    );
    await this.attachments.create({
      _id: id,
      ownerId,
      storageKey: key,
      contentType: dto.contentType,
      sizeBytes: dto.sizeBytes,
    });
    return { id, upload };
  }

  /**
   * Checks, before the write transaction, that every id is the caller's own
   * unsent upload and that its file reached storage.
   */
  async assertReady(ownerId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await this.attachments
      .find({ _id: { $in: [...ids] }, ownerId, messageId: null })
      .exec();
    if (rows.length !== ids.length) {
      throw new InvalidInputException(
        'UNKNOWN_ATTACHMENT',
        'An attached image does not exist or was already sent',
      );
    }
    const uploaded = await Promise.all(
      rows.map((row) =>
        this.storage.exists(StorageTarget.Support, row.storageKey),
      ),
    );
    if (uploaded.includes(false)) {
      throw new StateConflictException(
        'ATTACHMENT_NOT_UPLOADED',
        'An attached image has not finished uploading',
      );
    }
  }

  /**
   * Binds uploads to a message inside the caller's transaction. The filter
   * repeats the ownership check, so a concurrent send cannot reuse an image.
   */
  async attach(
    session: ClientSession,
    ownerId: string,
    ids: readonly string[],
    target: { ticketId: string; messageId: string },
  ): Promise<void> {
    if (ids.length === 0) return;
    const result = await this.attachments
      .updateMany(
        { _id: { $in: [...ids] }, ownerId, messageId: null },
        { $set: { ticketId: target.ticketId, messageId: target.messageId } },
        { session },
      )
      .exec();
    if (result.modifiedCount !== ids.length) {
      throw new InvalidInputException(
        'UNKNOWN_ATTACHMENT',
        'An attached image does not exist or was already sent',
      );
    }
  }

  /** Signed download URLs for the given messages, grouped by message id. */
  async forMessages(
    messageIds: readonly string[],
  ): Promise<Map<string, SupportAttachmentDto[]>> {
    const byMessage = new Map<string, SupportAttachmentDto[]>();
    if (messageIds.length === 0) return byMessage;

    const rows = await this.attachments
      .find({ messageId: { $in: [...messageIds] } })
      .sort({ createdAt: 1, _id: 1 })
      .exec();
    for (const row of rows) {
      if (!row.messageId) continue;
      const url = await this.storage.presignDownload(
        StorageTarget.Support,
        row.storageKey,
        URL_TTL_SECONDS,
      );
      const list = byMessage.get(row.messageId) ?? [];
      list.push({
        id: row.id,
        url,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
      });
      byMessage.set(row.messageId, list);
    }
    return byMessage;
  }

  @Cron(runtimeConfig.SUPPORT_ATTACHMENT_CLEANUP_CRON)
  async purgeUnsent(): Promise<void> {
    if (!this.storage.isConfigured()) return;
    const stale = await this.attachments
      .find({
        messageId: null,
        createdAt: { $lt: new Date(Date.now() - CLEANUP_AGE_MS) },
      })
      .sort({ createdAt: 1 })
      .limit(runtimeConfig.SUPPORT_ATTACHMENT_CLEANUP_BATCH_SIZE)
      .exec();
    for (const row of stale) {
      try {
        await this.storage.delete(StorageTarget.Support, row.storageKey);
      } catch (error) {
        this.logger.warn(`Could not purge ${row.storageKey}: ${String(error)}`);
        continue;
      }
      await this.attachments.deleteOne({ _id: row.id, messageId: null }).exec();
    }
  }
}
