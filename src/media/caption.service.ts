import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CaptionStatus,
  MediaAsset,
  MediaStatus,
  PostStatus,
  Prisma,
} from '@prisma/client';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { extractSpeechAudio } from './captions/speech-audio';
import {
  languageName,
  TranscriptionService,
  translationTarget,
} from './captions/transcription.service';
import { type Cue, toVtt, vttText } from './captions/vtt';

const BATCH_SIZE = 10;
/** A TRANSCRIBING row untouched this long was cut off by a restart. */
const STALE_AFTER_MS = 30 * 60 * 1000;
const TRACK_TIMEOUT_MS = 15_000;

/**
 * Captions published videos inside this process: ffmpeg extracts the audio
 * and cuts out the silence, Whisper transcribes what's left (timestamps are
 * mapped back onto the video), and the chat model translates Vietnamese to
 * English and everything else to Vietnamese. Both tracks are stored on
 * Cloudinary as WebVTT and listed in `media_captions`.
 *
 * Each video is claimed with a conditional status update, so the cron and
 * `schedule` calls can race without transcribing it twice.
 */
@Injectable()
export class CaptionService {
  private readonly logger = new Logger(CaptionService.name);
  private readonly enabled: boolean;
  private draining: Promise<void> | null = null;
  private drainAgain = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    private readonly transcription: TranscriptionService,
    configService: ConfigService,
  ) {
    this.enabled = configService.get<boolean>('CAPTIONS_ENABLED', true);
  }

  /** Captions waiting videos in the background; never throws. */
  schedule(): void {
    if (!this.enabled || !this.cloudinary.configured) return;
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = this.drain()
      .catch((error: unknown) => {
        this.logger.warn(`Captioning failed: ${String(error)}`);
      })
      .finally(() => {
        this.draining = null;
        if (this.drainAgain) {
          this.drainAgain = false;
          this.schedule();
        }
      });
  }

  /** Captions every waiting video, a batch at a time. */
  async drain(): Promise<void> {
    let found: number;
    do {
      const media = await this.prisma.mediaAsset.findMany({
        where: {
          discardedAt: null,
          status: MediaStatus.READY,
          captionStatus: CaptionStatus.NONE,
          post: { status: PostStatus.PUBLISHED },
        },
        orderBy: { updatedAt: 'asc' },
        take: BATCH_SIZE,
      });
      found = media.length;
      for (const item of media) {
        await this.caption(item);
      }
    } while (found === BATCH_SIZE);
  }

  /** Lets videos whose captioning a restart cut off be picked up again. */
  async releaseStale(): Promise<void> {
    await this.prisma.mediaAsset.updateMany({
      where: {
        captionStatus: CaptionStatus.TRANSCRIBING,
        updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) },
      },
      data: { captionStatus: CaptionStatus.NONE },
    });
  }

  /**
   * Fills `transcript` for videos captioned before it existed, from their
   * stored spoken-language track, and marks their posts for embedding again.
   * A track that fails to download is retried on the next run.
   */
  async backfillTranscripts(): Promise<void> {
    const media = await this.prisma.mediaAsset.findMany({
      where: {
        captionStatus: CaptionStatus.READY,
        transcript: null,
        captions: { some: { isOriginal: true } },
      },
      orderBy: { updatedAt: 'asc' },
      take: BATCH_SIZE,
      select: {
        id: true,
        postId: true,
        captions: { where: { isOriginal: true }, select: { url: true } },
      },
    });
    for (const { id, postId, captions } of media) {
      try {
        const response = await fetch(captions[0].url, {
          signal: AbortSignal.timeout(TRACK_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const transcript = vttText(await response.text());
        await this.prisma.mediaAsset.update({
          where: { id },
          data: { transcript },
        });
        if (postId) {
          await this.prisma.post.updateMany({
            where: { id: postId },
            data: { searchIndexedAt: null },
          });
        }
      } catch (error) {
        this.logger.warn(
          `Backfilling the transcript of media ${id} failed: ${String(error)}`,
        );
      }
    }
  }

  /** Transcribes, translates and stores the captions of one video. */
  async caption(
    media: Pick<MediaAsset, 'id' | 'publicId' | 'durationSec' | 'postId'>,
  ): Promise<void> {
    const { count } = await this.prisma.mediaAsset.updateMany({
      where: { id: media.id, captionStatus: CaptionStatus.NONE },
      data: { captionStatus: CaptionStatus.TRANSCRIBING },
    });
    if (count === 0) return;
    const current = {
      id: media.id,
      captionStatus: CaptionStatus.TRANSCRIBING,
    } satisfies Prisma.MediaAssetWhereInput;

    try {
      const speech = await extractSpeechAudio(
        this.cloudinary.originalUrl(media.publicId),
        media.durationSec ?? Number.POSITIVE_INFINITY,
      );
      const transcript = speech
        ? await this.transcription.transcribe(speech)
        : null;
      if (!transcript || transcript.cues.length === 0) {
        await this.prisma.mediaAsset.updateMany({
          where: current,
          data: { captionStatus: CaptionStatus.NO_SPEECH },
        });
        return;
      }

      const { language, cues } = transcript;
      await this.store(media.id, language, cues, true);
      await this.translate(media.id, language, cues);
      const { count: done } = await this.prisma.mediaAsset.updateMany({
        where: current,
        data: {
          captionStatus: CaptionStatus.READY,
          captionLanguage: language,
          transcript: cues.map((cue) => cue.text).join(' '),
        },
      });
      // The post is embedded again, now with what the video says.
      if (done > 0 && media.postId) {
        await this.prisma.post.updateMany({
          where: { id: media.postId },
          data: { searchIndexedAt: null },
        });
      }
    } catch (error) {
      this.logger.warn(`Captioning media ${media.id} failed: ${String(error)}`);
      await this.prisma.mediaAsset.updateMany({
        where: current,
        data: { captionStatus: CaptionStatus.FAILED },
      });
    }
  }

  /** The spoken-language captions are useful alone, so failures only log. */
  private async translate(
    mediaId: string,
    language: string,
    cues: Cue[],
  ): Promise<void> {
    const target = translationTarget(language);
    try {
      const translated = await this.transcription.translate(
        cues,
        language,
        target,
      );
      await this.store(mediaId, target, translated, false);
    } catch (error) {
      this.logger.warn(
        `Translating captions of media ${mediaId} failed: ${String(error)}`,
      );
    }
  }

  private async store(
    mediaId: string,
    language: string,
    cues: Cue[],
    isOriginal: boolean,
  ): Promise<void> {
    const url = await this.cloudinary.uploadCaption(
      mediaId,
      language,
      toVtt(cues),
    );
    const track = {
      name: languageName(language),
      isOriginal,
      url,
    };
    await this.prisma.mediaCaption.upsert({
      where: { mediaId_languageCode: { mediaId, languageCode: language } },
      create: { mediaId, languageCode: language, ...track },
      update: track,
    });
  }
}
