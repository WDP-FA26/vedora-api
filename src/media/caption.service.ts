import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  CaptionStatus,
  MediaAsset,
  MediaStatus,
  Post,
  PostStatus,
} from '../mongo/models';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
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
 * Cloudinary as WebVTT and listed in `media_assets.captions`.
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
    @InjectModel(MediaAsset.name)
    private readonly mediaAssets: Model<MediaAsset>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
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
      // MongoDB has no relation filters: load each video's post and keep
      // those of published posts.
      const waiting = await this.mediaAssets
        .find({
          discardedAt: null,
          status: MediaStatus.READY,
          captionStatus: CaptionStatus.NONE,
        })
        .sort({ updatedAt: 1 })
        .exec();
      const posts = await this.posts
        .find({ _id: { $in: waiting.map(({ postId }) => postId) } })
        .select('status')
        .exec();
      const published = new Set(
        posts
          .filter(({ status }) => status === PostStatus.PUBLISHED)
          .map(({ id }) => id),
      );
      const media = waiting
        .filter(({ postId }) => postId !== null && published.has(postId))
        .slice(0, BATCH_SIZE);
      found = media.length;
      for (const item of media) {
        await this.caption(item);
      }
    } while (found === BATCH_SIZE);
  }

  /** Lets videos whose captioning a restart cut off be picked up again. */
  async releaseStale(): Promise<void> {
    await this.mediaAssets.updateMany(
      {
        captionStatus: CaptionStatus.TRANSCRIBING,
        updatedAt: { $lt: new Date(Date.now() - STALE_AFTER_MS) },
      },
      { $set: { captionStatus: CaptionStatus.NONE } },
    );
  }

  /**
   * Fills `transcript` for videos captioned before it existed, from their
   * stored spoken-language track, and marks their posts for embedding again.
   * A track that fails to download is retried on the next run.
   */
  async backfillTranscripts(): Promise<void> {
    const media = await this.mediaAssets
      .find({
        captionStatus: CaptionStatus.READY,
        transcript: null,
        'captions.isOriginal': true,
      })
      .sort({ updatedAt: 1 })
      .limit(BATCH_SIZE)
      .select('postId captions')
      .exec();
    for (const { id, postId, captions } of media) {
      const original = captions.find(({ isOriginal }) => isOriginal);
      if (!original) continue;
      try {
        const response = await fetch(original.url, {
          signal: AbortSignal.timeout(TRACK_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const transcript = vttText(await response.text());
        await this.mediaAssets.updateOne({ _id: id }, { $set: { transcript } });
        if (postId) {
          await this.posts.updateOne(
            { _id: postId },
            { $set: { searchIndexedAt: null } },
          );
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
    const claimed = await this.mediaAssets
      .findOneAndUpdate(
        { _id: media.id, captionStatus: CaptionStatus.NONE },
        { $set: { captionStatus: CaptionStatus.TRANSCRIBING } },
        { returnDocument: 'after' },
      )
      .exec();
    if (!claimed) return;
    // Every later write requires TRANSCRIBING, so a released run can't write.
    const current = {
      _id: media.id,
      captionStatus: CaptionStatus.TRANSCRIBING,
    };

    try {
      const speech = await extractSpeechAudio(
        this.cloudinary.originalUrl(media.publicId),
        media.durationSec ?? Number.POSITIVE_INFINITY,
      );
      const transcript = speech
        ? await this.transcription.transcribe(speech)
        : null;
      if (!transcript || transcript.cues.length === 0) {
        await this.mediaAssets.updateOne(current, {
          $set: { captionStatus: CaptionStatus.NO_SPEECH },
        });
        return;
      }

      const { language, cues } = transcript;
      await this.store(media.id, language, cues, true);
      await this.translate(media.id, language, cues);
      const done = await this.mediaAssets
        .findOneAndUpdate(
          current,
          {
            $set: {
              captionStatus: CaptionStatus.READY,
              captionLanguage: language,
              transcript: cues.map((cue) => cue.text).join(' '),
            },
          },
          { returnDocument: 'after' },
        )
        .exec();
      // The post is embedded again, now with what the video says.
      if (done && media.postId) {
        await this.posts.updateOne(
          { _id: media.postId },
          { $set: { searchIndexedAt: null } },
        );
      }
    } catch (error) {
      this.logger.warn(`Captioning media ${media.id} failed: ${String(error)}`);
      await this.mediaAssets.updateOne(current, {
        $set: { captionStatus: CaptionStatus.FAILED },
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
      languageCode: language,
      name: languageName(language),
      isOriginal,
      url,
    };
    // One track per language. Only this process captions the video (it
    // holds TRANSCRIBING), so reading and then replacing the list is safe.
    const media = await this.mediaAssets
      .findOne({ _id: mediaId })
      .select('captions')
      .exec();
    const captions = media?.captions ?? [];
    await this.mediaAssets.updateOne(
      { _id: mediaId },
      {
        $set: {
          captions: [
            ...captions.filter(({ languageCode }) => languageCode !== language),
            track,
          ],
        },
      },
    );
  }
}
