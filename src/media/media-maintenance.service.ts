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

  /** Deletes uploads that were never posted, so Mux stops storing them. */
  @Cron(CronExpression.EVERY_HOUR)
  async deleteOrphans(): Promise<void> {
    const orphans = await this.prisma.mediaAsset.findMany({
      where: {
        postId: null,
        createdAt: { lt: new Date(Date.now() - ORPHAN_AFTER_MS) },
      },
      take: BATCH_SIZE,
    });
    for (const media of orphans) {
      const { count } = await this.prisma.mediaAsset.deleteMany({
        where: { id: media.id, postId: null },
      });
      if (count > 0) {
        await this.mediaService.deleteFromMux(media);
      }
    }
    if (orphans.length > 0) {
      this.logger.log(`Deleted ${orphans.length} unposted uploads`);
    }
  }
}
