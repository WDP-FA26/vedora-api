import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotFoundError } from '@mux/ts';
import type { Asset } from '@mux/ts/resources/video/assets';
import type { UnwrapWebhookEvent } from '@mux/ts/resources/webhooks/webhooks';
import {
  MediaAsset,
  MediaFailureReason,
  MediaStatus,
  MediaType,
  PostStatus,
  Prisma,
} from '@prisma/client';
import { isUUID } from 'class-validator';
import { MuxService } from '../mux/mux.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateUploadResponseDto,
  MediaResponseDto,
} from './dto/media-response.dto';

/** The asset fields we read, shared by API responses and webhook payloads. */
type MuxAsset = Pick<
  Asset,
  | 'id'
  | 'status'
  | 'passthrough'
  | 'upload_id'
  | 'duration'
  | 'aspect_ratio'
  | 'playback_ids'
>;

const PENDING: MediaStatus[] = [
  MediaStatus.WAITING_UPLOAD,
  MediaStatus.PROCESSING,
];

/** Rows that haven't been discarded; every user-facing query uses it. */
const LIVE = { discardedAt: null } satisfies Prisma.MediaAssetWhereInput;

/** Unattached uploads a user may hold at once, so one account can't flood Mux. */
const MAX_UNATTACHED_UPLOADS = 5;
/** Mux direct-upload URLs stop accepting the file after this long. */
const UPLOAD_URL_TTL_SECONDS = 3600;

/** Upload states after which no file will arrive. */
const UPLOAD_FAILURES = {
  errored: MediaFailureReason.UPLOAD_ERRORED,
  cancelled: MediaFailureReason.UPLOAD_CANCELLED,
  timed_out: MediaFailureReason.UPLOAD_TIMED_OUT,
} as const satisfies Record<string, MediaFailureReason>;

/**
 * Videos go straight from the browser to Mux: `createUpload` hands out a
 * direct-upload URL, and Mux reports progress through webhooks
 * (`handleWebhook`). When webhooks aren't configured (local dev) or one was
 * missed, `refresh` asks Mux for the current state instead. Every transition
 * is a conditional update, so replays and out-of-order events are harmless.
 *
 * Discarding is two-phase: `discard` marks the row, then `purge` deletes the
 * Mux upload/asset and only drops the row once Mux confirms nothing is left.
 * An asset Mux creates after the discard (the file had just finished) is
 * caught by its webhook or by the maintenance cron, so nothing lingers in Mux.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly frontendUrl: string;
  private readonly maxVideoDurationSec: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mux: MuxService,
    configService: ConfigService,
  ) {
    this.frontendUrl = configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:3000',
    );
    this.maxVideoDurationSec = configService.get<number>(
      'MAX_VIDEO_DURATION_SEC',
      180,
    );
  }

  /** Only VIDEO for now (Mux); IMAGE will get presigned storage URLs. */
  async createUpload(
    ownerId: string,
    type: MediaType,
  ): Promise<CreateUploadResponseDto> {
    const mux = this.mux.require();

    const unattached = await this.prisma.mediaAsset.count({
      where: {
        ...LIVE,
        ownerId,
        postId: null,
        status: { not: MediaStatus.FAILED },
      },
    });
    if (unattached >= MAX_UNATTACHED_UPLOADS) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: 'UPLOAD_LIMIT_REACHED',
          message:
            'Too many uploads not attached to a post; post or remove them first',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const media = await this.prisma.mediaAsset.create({
      data: { ownerId, type },
    });
    try {
      const upload = await mux.video.uploads.create({
        cors_origin: this.frontendUrl,
        timeout: UPLOAD_URL_TTL_SECONDS,
        new_asset_settings: {
          playback_policies: ['public'],
          video_quality: 'basic',
          max_resolution_tier: '1080p',
          passthrough: media.id,
        },
      });
      if (!upload.url) {
        throw new Error(`Mux upload ${upload.id} has no URL`);
      }
      const updated = await this.prisma.mediaAsset.update({
        where: { id: media.id },
        data: { muxUploadId: upload.id },
      });
      return { media: this.toResponse(updated), uploadUrl: upload.url };
    } catch (error) {
      await this.prisma.mediaAsset.delete({ where: { id: media.id } });
      throw error;
    }
  }

  async findOwned(id: string, ownerId: string): Promise<MediaResponseDto> {
    let media = await this.prisma.mediaAsset.findFirst({
      where: { ...LIVE, id, ownerId },
    });
    if (!media) {
      throw new NotFoundException('Media not found');
    }
    if (!this.mux.webhooksEnabled && PENDING.includes(media.status)) {
      await this.refresh(media);
      media = await this.prisma.mediaAsset.findUniqueOrThrow({
        where: { id },
      });
    }
    return this.toResponse(media);
  }

  /** Removes an upload the user dropped from the composer before posting. */
  async removeOwned(id: string, ownerId: string): Promise<void> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { ...LIVE, id, ownerId },
    });
    if (!media) {
      throw new NotFoundException('Media not found');
    }
    if (media.postId) {
      throw new ConflictException('Media is attached to a post');
    }
    await this.discard({ id, postId: null });
  }

  /**
   * Hides the matching media from every query, then deletes it from Mux.
   * Rows that Mux can't confirm gone yet are retried by `purge` later.
   */
  async discard(where: Prisma.MediaAssetWhereInput): Promise<void> {
    const media = await this.prisma.mediaAsset.findMany({
      where: { ...where, ...LIVE },
    });
    if (media.length === 0) return;
    await this.prisma.mediaAsset.updateMany({
      where: { id: { in: media.map(({ id }) => id) }, ...LIVE },
      data: { discardedAt: new Date() },
    });
    for (const item of media) {
      await this.purge(item);
    }
  }

  /**
   * Deletes a discarded video from Mux, then from our database. Mux goes
   * first: if it fails, the row stays (still discarded) and the
   * `purgeDiscarded` cron or a late webhook tries again. Returns whether the
   * video is fully gone.
   */
  async purge(
    media: Pick<MediaAsset, 'id' | 'muxAssetId' | 'muxUploadId'>,
  ): Promise<boolean> {
    if (!(await this.deleteFromMux(media))) return false;
    await this.prisma.mediaAsset.deleteMany({
      where: { id: media.id, discardedAt: { not: null } },
    });
    return true;
  }

  /**
   * Attaches the owner's uploads to a new post, in `mediaIds` order. Runs in
   * the post's transaction; each claim is conditional, so media that belongs
   * to someone else, is already attached or has failed is rejected.
   */
  async claimForPost(
    tx: Prisma.TransactionClient,
    ownerId: string,
    postId: string,
    mediaIds: string[],
  ): Promise<void> {
    for (const [position, id] of mediaIds.entries()) {
      const { count } = await tx.mediaAsset.updateMany({
        where: {
          ...LIVE,
          id,
          ownerId,
          postId: null,
          status: { not: MediaStatus.FAILED },
        },
        data: { postId, position },
      });
      if (count !== 1) {
        throw new BadRequestException({
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          code: 'MEDIA_UNAVAILABLE',
          message: `Media ${id} can't be attached: it doesn't exist, is used by another post, or failed to process`,
        });
      }
    }
  }

  /**
   * Moves PROCESSING posts matching `where` to FAILED if any of their media
   * failed, or to PUBLISHED once all of it is READY. Call it after any change
   * to media status or attachment has been committed: whichever change lands
   * last then sees the final state, so concurrent updates can't strand a post.
   */
  async settlePosts(where: Prisma.PostWhereInput): Promise<void> {
    await this.prisma.post.updateMany({
      where: {
        AND: [
          where,
          { status: PostStatus.PROCESSING },
          { media: { some: { status: MediaStatus.FAILED } } },
        ],
      },
      data: { status: PostStatus.FAILED },
    });
    await this.prisma.post.updateMany({
      where: {
        AND: [
          where,
          { status: PostStatus.PROCESSING },
          { media: { every: { status: MediaStatus.READY } } },
        ],
      },
      data: { status: PostStatus.PUBLISHED, publishedAt: new Date() },
    });
  }

  async handleWebhook(event: UnwrapWebhookEvent): Promise<void> {
    switch (event.type) {
      case 'video.upload.asset_created':
        if (event.data.asset_id) {
          await this.markAssetCreated(event.data.id, event.data.asset_id);
        }
        break;
      case 'video.upload.errored':
        await this.markFailed(
          { muxUploadId: event.data.id },
          MediaFailureReason.UPLOAD_ERRORED,
        );
        break;
      case 'video.upload.cancelled':
        await this.markFailed(
          { muxUploadId: event.data.id },
          MediaFailureReason.UPLOAD_CANCELLED,
        );
        break;
      case 'video.asset.ready':
        await this.applyAssetReady(event.data);
        break;
      case 'video.asset.errored':
        await this.markFailed(
          this.assetWhere(event.data),
          MediaFailureReason.ENCODING_FAILED,
        );
        break;
      default:
        break;
    }
  }

  /** Brings pending media up to date by asking Mux, for when no webhook came. */
  async refresh(media: MediaAsset): Promise<void> {
    if (!PENDING.includes(media.status) || !this.mux.configured) return;
    const mux = this.mux.require();

    try {
      let assetId = media.muxAssetId;
      if (!assetId && media.muxUploadId) {
        const upload = await mux.video.uploads.retrieve(media.muxUploadId);
        if (
          upload.status === 'errored' ||
          upload.status === 'cancelled' ||
          upload.status === 'timed_out'
        ) {
          await this.markFailed(
            { id: media.id },
            UPLOAD_FAILURES[upload.status],
          );
          return;
        }
        if (!upload.asset_id) return;
        assetId = upload.asset_id;
        await this.markAssetCreated(media.muxUploadId, assetId);
      }
      if (!assetId) return;

      const asset = await mux.video.assets.retrieve(assetId);
      if (asset.status === 'ready') {
        await this.applyAssetReady(asset);
      } else if (asset.status === 'errored') {
        await this.markFailed(
          { id: media.id },
          MediaFailureReason.ENCODING_FAILED,
        );
      }
    } catch (error) {
      if (error instanceof NotFoundError) {
        await this.markFailed(
          { id: media.id },
          MediaFailureReason.UPLOAD_ERRORED,
        );
        return;
      }
      this.logger.warn(`Refreshing media ${media.id} failed: ${String(error)}`);
    }
  }

  /**
   * Deletes the Mux side of `media`: cancels an unfinished upload and deletes
   * its asset. Returns whether Mux is confirmed to hold nothing for it;
   * failures are logged, not thrown, so callers can retry later.
   */
  async deleteFromMux(
    media: Pick<MediaAsset, 'id' | 'muxAssetId' | 'muxUploadId'>,
  ): Promise<boolean> {
    if (!this.mux.configured) return true;
    const mux = this.mux.require();
    try {
      let assetId = media.muxAssetId;
      if (!assetId && media.muxUploadId) {
        const upload = await mux.video.uploads.retrieve(media.muxUploadId);
        if (upload.status === 'waiting') {
          // Fails if the file finished meanwhile; the retry finds the asset.
          await mux.video.uploads.cancel(media.muxUploadId);
          return true;
        }
        assetId = upload.asset_id ?? null;
      }
      if (assetId) {
        await this.deleteAsset(assetId);
      }
      return true;
    } catch (error) {
      if (error instanceof NotFoundError) return true;
      this.logger.warn(
        `Deleting Mux resources of media ${media.id} failed: ${String(error)}`,
      );
      return false;
    }
  }

  private async deleteAsset(assetId: string): Promise<void> {
    try {
      await this.mux.require().video.assets.delete(assetId);
    } catch (error) {
      // Already gone counts as deleted.
      if (!(error instanceof NotFoundError)) throw error;
    }
  }

  toResponse(media: MediaAsset): MediaResponseDto {
    return {
      id: media.id,
      type: media.type,
      status: media.status,
      failureReason: media.failureReason,
      playbackId: media.playbackId,
      durationSec: media.durationSec,
      aspectRatio: media.aspectRatio,
    };
  }

  private async markAssetCreated(
    muxUploadId: string,
    muxAssetId: string,
  ): Promise<void> {
    const discarded = await this.prisma.mediaAsset.findFirst({
      where: { muxUploadId, discardedAt: { not: null } },
    });
    if (discarded) {
      // The file finished after the user discarded it.
      await this.purge({ ...discarded, muxAssetId });
      return;
    }
    await this.prisma.mediaAsset.updateMany({
      where: { ...LIVE, muxUploadId, status: MediaStatus.WAITING_UPLOAD },
      data: { status: MediaStatus.PROCESSING, muxAssetId },
    });
  }

  private async applyAssetReady(asset: MuxAsset): Promise<void> {
    const where = this.assetWhere(asset);
    const media = await this.prisma.mediaAsset.findFirst({ where });
    if (!media) return;
    if (media.discardedAt) {
      await this.purge({ ...media, muxAssetId: asset.id });
      return;
    }
    if (!PENDING.includes(media.status)) return;

    if ((asset.duration ?? 0) > this.maxVideoDurationSec) {
      await this.markFailed({ id: media.id }, MediaFailureReason.TOO_LONG);
      await this.deleteFromMux({ ...media, muxAssetId: asset.id });
      return;
    }
    const playbackId = asset.playback_ids?.find(
      (playback) => playback.policy === 'public',
    )?.id;
    if (!playbackId) {
      await this.markFailed(
        { id: media.id },
        MediaFailureReason.NO_PLAYBACK_ID,
      );
      return;
    }

    await this.prisma.mediaAsset.updateMany({
      where: { id: media.id, status: { in: PENDING } },
      data: {
        status: MediaStatus.READY,
        muxAssetId: asset.id,
        playbackId,
        durationSec: asset.duration ?? null,
        aspectRatio: asset.aspect_ratio ?? null,
      },
    });
    await this.settlePosts({ media: { some: { id: media.id } } });
  }

  private async markFailed(
    where: Prisma.MediaAssetWhereInput,
    reason: MediaFailureReason,
  ): Promise<void> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { ...where, ...LIVE },
    });
    if (!media) return;
    const { count } = await this.prisma.mediaAsset.updateMany({
      where: { id: media.id, status: { in: PENDING } },
      data: { status: MediaStatus.FAILED, failureReason: reason },
    });
    if (count > 0) {
      this.logger.log(`Media ${media.id} failed: ${reason}`);
      await this.settlePosts({ media: { some: { id: media.id } } });
      // A failed video can never play; free the Mux storage now. The row
      // stays so the author sees why, and discarding it later retries this.
      await this.deleteFromMux(media);
    }
  }

  /** Finds our row for a Mux asset: by passthrough, else by asset or upload ID. */
  private assetWhere(
    asset: Pick<MuxAsset, 'id' | 'passthrough' | 'upload_id'>,
  ): Prisma.MediaAssetWhereInput {
    if (asset.passthrough && isUUID(asset.passthrough)) {
      return { id: asset.passthrough };
    }
    return {
      OR: [
        { muxAssetId: asset.id },
        ...(asset.upload_id ? [{ muxUploadId: asset.upload_id }] : []),
      ],
    };
  }
}
