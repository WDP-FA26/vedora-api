import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APIError } from '@mux/ts';
import type { GeneratePremiumCaptionsJobOutputs } from '@mux/ts/resources/robots/jobs/generate-premium-captions';
import {
  CaptionStatus,
  MediaAsset,
  MediaStatus,
  PostStatus,
  Prisma,
} from '@prisma/client';
import { MuxService } from '../mux/mux.service';
import { PrismaService } from '../prisma/prisma.service';
import { CaptionTrackDto } from './dto/media-response.dto';

/** Biases transcription toward these spellings (at most 5 words each). */
const CAPTION_PHRASES = [
  'Vedora',
  'tàu hủ',
  'đậu hũ',
  'chao',
  'nấm mèo',
  'bún tàu',
  'hạt nêm',
  'dầu điều',
  'nước tương',
  'mắm chay',
  'tempeh',
  'seitan',
];
const NEVER_TRANSLATE = ['Vedora'];

/**
 * Below this, Mux's language detection was guessing; on our test clips that
 * only happened without speech (0.40 and 0.48, against 0.99 for speech).
 */
const MIN_LANGUAGE_CONFIDENCE = 0.7;
const SRT_FETCH_TIMEOUT_MS = 10_000;
const BATCH_SIZE = 50;

const JOB_RUNNING = ['pending', 'processing'];

type CaptionMedia = Pick<
  MediaAsset,
  | 'id'
  | 'muxAssetId'
  | 'captionStatus'
  | 'captionJobId'
  | 'captionTrackId'
  | 'captionLanguage'
>;

/**
 * Captions published videos with Mux Robots: `generate-premium-captions`
 * transcribes the spoken language, we attach that track ourselves (so silent
 * clips get none and the track carries its native name), and
 * `translate-captions` adds English to Vietnamese videos and Vietnamese to
 * the rest. MuxPlayer lists both tracks in its CC menu.
 *
 * Each step starts with a conditional status update, so webhooks and the
 * cron can race without starting a job twice. Webhooks only say which row to
 * look at; `advance` reads the job or track from Mux either way.
 */
@Injectable()
export class CaptionService {
  private readonly logger = new Logger(CaptionService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mux: MuxService,
    configService: ConfigService,
  ) {
    this.enabled = configService.get<boolean>('MUX_CAPTIONS_ENABLED', false);
  }

  /** Starts captions for ready videos of published posts matching `where`. */
  async start(where: Prisma.MediaAssetWhereInput = {}): Promise<void> {
    if (!this.enabled || !this.mux.configured) return;
    const media = await this.prisma.mediaAsset.findMany({
      where: {
        AND: [
          where,
          {
            discardedAt: null,
            status: MediaStatus.READY,
            captionStatus: CaptionStatus.NONE,
            muxAssetId: { not: null },
            post: { status: PostStatus.PUBLISHED },
          },
        ],
      },
      take: BATCH_SIZE,
    });
    for (const item of media) {
      await this.generate(item);
    }
  }

  /** Moves captioning along after a job or track changed in Mux. */
  async advance(media: CaptionMedia): Promise<void> {
    if (!this.mux.configured) return;
    try {
      switch (media.captionStatus) {
        case CaptionStatus.GENERATING:
          await this.checkGeneration(media);
          break;
        case CaptionStatus.ATTACHING:
          await this.translate(media);
          break;
        case CaptionStatus.TRANSLATING:
          await this.checkTranslation(media);
          break;
        default:
          break;
      }
    } catch (error) {
      this.logger.warn(
        `Captioning media ${media.id} failed: ${String(error)}; retrying later`,
      );
    }
  }

  /**
   * The asset's ready caption tracks, spoken language first. The translated
   * track's id is only known to Mux, so this asks it each time.
   */
  async listTracks(
    media: Pick<
      MediaAsset,
      'id' | 'muxAssetId' | 'playbackId' | 'captionTrackId'
    >,
  ): Promise<CaptionTrackDto[]> {
    if (!media.muxAssetId || !media.playbackId || !media.captionTrackId) {
      return [];
    }
    if (!this.mux.configured) return [];
    try {
      const asset = await this.mux
        .require()
        .video.assets.retrieve(media.muxAssetId);
      return (asset.tracks ?? [])
        .filter(
          (track) =>
            track.type === 'text' && track.status === 'ready' && track.id,
        )
        .map((track) => ({
          id: track.id!,
          languageCode: track.language_code ?? null,
          name: track.name ?? languageName(track.language_code ?? ''),
          isOriginal: track.id === media.captionTrackId,
          url: `https://stream.mux.com/${media.playbackId}/text/${track.id}.vtt`,
        }))
        .sort((a, b) => Number(b.isOriginal) - Number(a.isOriginal));
    } catch (error) {
      this.logger.warn(
        `Listing caption tracks of media ${media.id} failed: ${String(error)}`,
      );
      return [];
    }
  }

  async handleJobEvent(jobId: string): Promise<void> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { captionJobId: jobId, discardedAt: null },
    });
    if (media) await this.advance(media);
  }

  async handleTrackEvent(trackId: string): Promise<void> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: {
        captionTrackId: trackId,
        captionStatus: CaptionStatus.ATTACHING,
        discardedAt: null,
      },
    });
    if (media) await this.advance(media);
  }

  /** Rows still waiting on Mux that haven't changed since `staleBefore`. */
  async findInFlight(staleBefore: Date): Promise<MediaAsset[]> {
    return this.prisma.mediaAsset.findMany({
      where: {
        discardedAt: null,
        OR: [
          {
            captionStatus: {
              in: [CaptionStatus.GENERATING, CaptionStatus.TRANSLATING],
            },
            captionJobId: { not: null },
          },
          {
            captionStatus: CaptionStatus.ATTACHING,
            captionTrackId: { not: null },
          },
        ],
        updatedAt: { lt: staleBefore },
      },
      orderBy: { updatedAt: 'asc' },
      take: BATCH_SIZE,
    });
  }

  private async generate(media: CaptionMedia): Promise<void> {
    const { count } = await this.prisma.mediaAsset.updateMany({
      where: { id: media.id, captionStatus: CaptionStatus.NONE },
      data: { captionStatus: CaptionStatus.GENERATING },
    });
    if (count === 0) return;
    try {
      const job = await this.mux
        .require()
        .robots.jobs.generatePremiumCaptions.create({
          parameters: {
            asset_id: media.muxAssetId!,
            phrases: CAPTION_PHRASES,
            upload_to_mux: false,
          },
          passthrough: media.id,
        });
      await this.prisma.mediaAsset.updateMany({
        where: { id: media.id, captionStatus: CaptionStatus.GENERATING },
        data: { captionJobId: job.id },
      });
    } catch (error) {
      // Mux refused the request itself: retrying won't help.
      const refused =
        error instanceof APIError &&
        error.status !== undefined &&
        error.status < 500;
      this.logger.warn(
        `Starting captions for media ${media.id} failed: ${String(error)}`,
      );
      await this.prisma.mediaAsset.updateMany({
        where: { id: media.id, captionStatus: CaptionStatus.GENERATING },
        data: {
          captionStatus: refused ? CaptionStatus.FAILED : CaptionStatus.NONE,
        },
      });
    }
  }

  private async checkGeneration(media: CaptionMedia): Promise<void> {
    if (!media.captionJobId) return;
    const mux = this.mux.require();
    const job = await mux.robots.jobs.generatePremiumCaptions.retrieve(
      media.captionJobId,
    );
    if (JOB_RUNNING.includes(job.status)) return;

    const current = {
      id: media.id,
      captionStatus: CaptionStatus.GENERATING,
      captionJobId: job.id,
    };
    const outputs = job.status === 'completed' ? job.outputs : undefined;
    if (!outputs?.temporary_srt_url) {
      this.logger.warn(
        `Caption job ${job.id} for media ${media.id} ended ${job.status}: ${JSON.stringify(job.errors ?? [])}`,
      );
      await this.prisma.mediaAsset.updateMany({
        where: current,
        data: { captionStatus: CaptionStatus.FAILED, captionJobId: null },
      });
      return;
    }
    if (!(await this.hasSpeech(outputs))) {
      await this.prisma.mediaAsset.updateMany({
        where: current,
        data: { captionStatus: CaptionStatus.NO_SPEECH, captionJobId: null },
      });
      return;
    }

    const language = outputs.language_code;
    const { count } = await this.prisma.mediaAsset.updateMany({
      where: current,
      data: {
        captionStatus: CaptionStatus.ATTACHING,
        captionJobId: null,
        captionLanguage: language,
      },
    });
    if (count === 0) return;
    try {
      const track = await mux.video.assets.createTrack(media.muxAssetId!, {
        url: outputs.temporary_srt_url,
        type: 'text',
        text_type: 'subtitles',
        language_code: language,
        name: languageName(language),
      });
      await this.prisma.mediaAsset.update({
        where: { id: media.id },
        data: { captionTrackId: track.id },
      });
    } catch (error) {
      this.logger.warn(
        `Attaching captions to media ${media.id} failed: ${String(error)}`,
      );
      await this.prisma.mediaAsset.updateMany({
        where: { id: media.id, captionStatus: CaptionStatus.ATTACHING },
        data: { captionStatus: CaptionStatus.FAILED },
      });
    }
  }

  /** Once the attached track is ready, starts translating it. */
  private async translate(media: CaptionMedia): Promise<void> {
    if (!media.captionTrackId || !media.captionLanguage) return;
    const mux = this.mux.require();
    const asset = await mux.video.assets.retrieve(media.muxAssetId!);
    const track = asset.tracks?.find(({ id }) => id === media.captionTrackId);
    if (track?.status === 'preparing') return;
    if (track?.status !== 'ready') {
      await this.prisma.mediaAsset.updateMany({
        where: { id: media.id, captionStatus: CaptionStatus.ATTACHING },
        data: { captionStatus: CaptionStatus.FAILED },
      });
      return;
    }

    const { count } = await this.prisma.mediaAsset.updateMany({
      where: {
        id: media.id,
        captionStatus: CaptionStatus.ATTACHING,
        captionTrackId: media.captionTrackId,
      },
      data: { captionStatus: CaptionStatus.TRANSLATING },
    });
    if (count === 0) return;
    try {
      const job = await mux.robots.jobs.translateCaptions.create({
        parameters: {
          asset_id: asset.id,
          track_id: media.captionTrackId,
          to_language_code: translationTarget(media.captionLanguage),
          never_translate: NEVER_TRANSLATE,
        },
        passthrough: media.id,
      });
      await this.prisma.mediaAsset.updateMany({
        where: { id: media.id, captionStatus: CaptionStatus.TRANSLATING },
        data: { captionJobId: job.id },
      });
    } catch (error) {
      // The spoken-language captions are attached and useful on their own.
      this.logger.warn(
        `Translating captions of media ${media.id} failed: ${String(error)}`,
      );
      await this.prisma.mediaAsset.updateMany({
        where: { id: media.id, captionStatus: CaptionStatus.TRANSLATING },
        data: { captionStatus: CaptionStatus.READY },
      });
    }
  }

  private async checkTranslation(media: CaptionMedia): Promise<void> {
    if (!media.captionJobId) return;
    const job = await this.mux
      .require()
      .robots.jobs.translateCaptions.retrieve(media.captionJobId);
    if (JOB_RUNNING.includes(job.status)) return;
    if (job.status !== 'completed') {
      this.logger.warn(
        `Translation job ${job.id} for media ${media.id} ended ${job.status}: ${JSON.stringify(job.errors ?? [])}`,
      );
    }
    await this.prisma.mediaAsset.updateMany({
      where: {
        id: media.id,
        captionStatus: CaptionStatus.TRANSLATING,
        captionJobId: job.id,
      },
      data: { captionStatus: CaptionStatus.READY, captionJobId: null },
    });
  }

  /**
   * Silent clips still come back as one cue like `[beep]` or `[pause]`, with
   * a low-confidence language guess.
   */
  private async hasSpeech(
    outputs: GeneratePremiumCaptionsJobOutputs,
  ): Promise<boolean> {
    if ((outputs.auto_language_confidence ?? 1) < MIN_LANGUAGE_CONFIDENCE) {
      return false;
    }
    const response = await fetch(outputs.temporary_srt_url!, {
      signal: AbortSignal.timeout(SRT_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Downloading captions answered ${response.status}`);
    }
    return srtHasSpeech(await response.text());
  }
}

/** Whether any cue has words outside sound tags like `[music]`. */
export function srtHasSpeech(srt: string): boolean {
  return srt
    .split(/\r?\n/)
    .filter((line) => !/^\d+$/.test(line.trim()) && !line.includes('-->'))
    .some((line) => /\p{L}/u.test(line.replace(/\[[^\]]*\]|\([^)]*\)/g, '')));
}

/** Vietnamese videos get English captions; everything else gets Vietnamese. */
export function translationTarget(language: string): string {
  return language.split('-')[0].toLowerCase() === 'vi' ? 'en' : 'vi';
}

/** The language's own name for the CC menu, e.g. "Tiếng Việt". */
export function languageName(language: string): string {
  try {
    const name = new Intl.DisplayNames([language], { type: 'language' }).of(
      language,
    );
    if (name && name !== language) {
      return name.charAt(0).toLocaleUpperCase(language) + name.slice(1);
    }
  } catch {
    // Not a valid language tag.
  }
  return language;
}
