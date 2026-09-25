import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MediaStatus } from '@prisma/client';
import { MuxService } from '../mux/mux.service';
import { PrismaService } from '../prisma/prisma.service';
import { MediaService } from './media.service';

const STALE_AFTER_MS = 10 * 60 * 1000;
const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 50;

@Injectable()
export class MediaMaintenanceService {
  private readonly logger = new Logger(MediaMaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mux: MuxService,
    private readonly mediaService: MediaService,
  ) {}

  /** Catches up on media whose webhook never arrived. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async refreshStale(): Promise<void> {
    if (!this.mux.configured) return;
    const stale = await this.prisma.mediaAsset.findMany({
      where: {
        discardedAt: null,
        status: { in: [MediaStatus.WAITING_UPLOAD, MediaStatus.PROCESSING] },
        updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) },
      },
      orderBy: { updatedAt: 'asc' },
      take: BATCH_SIZE,
    });
    for (const media of stale) {
      await this.mediaService.refresh(media);
    }
  }

  /** Discards uploads that were never posted, so Mux stops storing them. */
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
   * Deletes discarded media from Mux: uploads whose owner deleted their
   * account, and retries for when Mux was unreachable or the upload finished
   * just after the discard and no webhook came.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async purgeDiscarded(): Promise<void> {
    if (!this.mux.configured) return;
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
