import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MediaStatus } from '@prisma/client';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { CaptionService } from './caption.service';
import { MediaService } from './media.service';

const STALE_AFTER_MS = 10 * 60 * 1000;
const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 50;
/** Each refresh is one Admin API call, of 500 allowed per hour. */
const REFRESH_BATCH_SIZE = 20;

@Injectable()
export class MediaMaintenanceService {
  private readonly logger = new Logger(MediaMaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    private readonly mediaService: MediaService,
    private readonly captions: CaptionService,
  ) {}

  /** Catches up on media whose notification never arrived. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async refreshStale(): Promise<void> {
    if (!this.cloudinary.configured) return;
    const stale = await this.prisma.mediaAsset.findMany({
      where: {
        discardedAt: null,
        status: { in: [MediaStatus.WAITING_UPLOAD, MediaStatus.PROCESSING] },
        updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) },
      },
      orderBy: { updatedAt: 'asc' },
      take: REFRESH_BATCH_SIZE,
    });
    for (const media of stale) {
      await this.mediaService.refresh(media);
    }
  }

  /** Picks up captions a restart cut off, or that no publish scheduled. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async advanceCaptions(): Promise<void> {
    await this.captions.releaseStale();
    this.captions.schedule();
  }

  /** Gives videos captioned before transcripts were stored theirs. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  backfillTranscripts(): Promise<void> {
    return this.captions.backfillTranscripts();
  }

  /** Discards uploads that were never posted, so Cloudinary stops storing them. */
  @Cron(CronExpression.EVERY_HOUR)
  async deleteOrphans(): Promise<void> {
    const orphans = await this.prisma.mediaAsset.findMany({
      where: {
        postId: null,
        discardedAt: null,
        createdAt: { lt: new Date(Date.now() - ORPHAN_AFTER_MS) },
      },
      select: { id: true },
      take: BATCH_SIZE,
    });
    if (orphans.length === 0) return;
    await this.mediaService.discard({
      id: { in: orphans.map(({ id }) => id) },
      postId: null,
    });
    this.logger.log(`Discarded ${orphans.length} unposted uploads`);
  }

  /**
   * Deletes discarded media from Cloudinary: uploads whose owner deleted
   * their account, retries for when Cloudinary was unreachable, and uploads
   * discarded while their file could still arrive.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async purgeDiscarded(): Promise<void> {
    if (!this.cloudinary.configured) return;
    // Media whose owner deleted their account is discarded along with it.
    await this.prisma.mediaAsset.updateMany({
      where: { ownerId: null, discardedAt: null },
      data: { discardedAt: new Date() },
    });
    const discarded = await this.prisma.mediaAsset.findMany({
      where: { discardedAt: { not: null } },
      orderBy: { discardedAt: 'asc' },
      take: BATCH_SIZE,
    });
    for (const media of discarded) {
      await this.mediaService.purge(media);
    }
  }
}
