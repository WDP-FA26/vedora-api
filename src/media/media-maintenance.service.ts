import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { MediaAsset, MediaStatus, Post, PostStatus } from '../mongo/models.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { CaptionService } from './captions/caption.service.js';
import { MediaService } from './media.service.js';

const STALE_AFTER_MS = 10 * 60 * 1000;
const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 50;
const RETRY_MODERATION_AFTER_MS = 2 * 60 * 1000;
const REFRESH_BATCH_SIZE = 20;

@Injectable()
export class MediaMaintenanceService {
  private readonly logger = new Logger(MediaMaintenanceService.name);

  constructor(
    @InjectModel(MediaAsset.name)
    private readonly mediaAssets: Model<MediaAsset>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    private readonly cloudinary: CloudinaryService,
    private readonly mediaService: MediaService,
    private readonly captions: CaptionService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async refreshStale(): Promise<void> {
    if (!this.cloudinary.configured) return;
    const stale = await this.mediaAssets
      .find({
        discardedAt: null,
        status: {
          $in: [MediaStatus.WAITING_UPLOAD, MediaStatus.PROCESSING],
        },
        updatedAt: { $lt: new Date(Date.now() - STALE_AFTER_MS) },
      })
      .sort({ updatedAt: 1 })
      .limit(REFRESH_BATCH_SIZE)
      .exec();
    for (const media of stale) {
      await this.mediaService.refresh(media);
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async retryModeration(): Promise<void> {
    const pending = await this.posts
      .find({
        status: PostStatus.PROCESSING,
        updatedAt: { $lt: new Date(Date.now() - RETRY_MODERATION_AFTER_MS) },
      })
      .select('_id')
      .sort({ updatedAt: 1 })
      .limit(BATCH_SIZE)
      .exec();
    if (pending.length === 0) return;
    await this.mediaService.settlePosts(pending.map(({ id }) => id));
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async advanceCaptions(): Promise<void> {
    await this.captions.releaseStale();
    this.captions.schedule();
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  backfillTranscripts(): Promise<void> {
    return this.captions.backfillTranscripts();
  }

  @Cron(CronExpression.EVERY_HOUR)
  async deleteOrphans(): Promise<void> {
    const orphans = await this.mediaAssets
      .find({
        postId: null,
        discardedAt: null,
        createdAt: { $lt: new Date(Date.now() - ORPHAN_AFTER_MS) },
      })
      .select('_id')
      .limit(BATCH_SIZE)
      .exec();
    if (orphans.length === 0) return;
    await this.mediaService.discard({
      _id: { $in: orphans.map(({ id }) => id) },
      postId: null,
    });

    this.logger.log(`Discarded ${orphans.length} unposted uploads`);
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async purgeDiscarded(): Promise<void> {
    if (!this.cloudinary.configured) return;
    await this.mediaAssets.updateMany(
      { ownerId: null, discardedAt: null },
      { $set: { discardedAt: new Date() } },
    );
    const discarded = await this.mediaAssets
      .find({ discardedAt: { $ne: null } })
      .sort({ discardedAt: 1 })
      .limit(BATCH_SIZE)
      .exec();
    for (const media of discarded) {
      await this.mediaService.purge(media);
    }
  }
}
