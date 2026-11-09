import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Subject } from 'rxjs';
import {
  CaptionStatus,
  MediaAsset,
  MediaStatus,
  Post,
  PostStatus,
} from '../../mongo/models.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import { extractSpeechAudio } from './speech-audio.js';
import { ExternalServiceException } from '../../common/exceptions/external-service.exception.js';
import {
  languageName,
  TranscriptionService,
  translationTarget,
} from './transcription.service.js';
import { type Cue, toVtt, vttText } from './vtt.js';

const BATCH_SIZE = 10;
const STALE_AFTER_MS = 30 * 60 * 1000;
const TRACK_TIMEOUT_MS = 15_000;

@Injectable()
export class CaptionService {
  private readonly logger = new Logger(CaptionService.name);
  private readonly enabled: boolean;
  private draining: Promise<void> | null = null;
  private drainAgain = false;

  readonly transcribed = new Subject<string>();

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

  get active(): boolean {
    return this.enabled && this.cloudinary.configured;
  }

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

  async drain(): Promise<void> {
    let found: number;
    do {
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
      const captionable = new Set(
        posts
          .filter(
            ({ status }) =>
              status === PostStatus.PUBLISHED ||
              status === PostStatus.PROCESSING,
          )
          .map(({ id }) => id),
      );
      const media = waiting
        .filter(({ postId }) => postId !== null && captionable.has(postId))
        .slice(0, BATCH_SIZE);
      found = media.length;
      for (const item of media) {
        await this.caption(item);
      }
    } while (found === BATCH_SIZE);
  }

  async releaseStale(): Promise<void> {
    await this.mediaAssets.updateMany(
      {
        captionStatus: CaptionStatus.TRANSCRIBING,
        updatedAt: { $lt: new Date(Date.now() - STALE_AFTER_MS) },
      },
      { $set: { captionStatus: CaptionStatus.NONE } },
    );
  }

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
        if (!response.ok) {
          throw new ExternalServiceException(
            'cloudinary',
            `HTTP ${response.status}`,
          );
        }
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
        this.announce(media.postId);
        return;
      }

      const { language, cues } = transcript;
      await this.store(media.id, language, cues, true);
      await this.mediaAssets.updateOne(current, {
        $set: { transcript: cues.map((cue) => cue.text).join(' ') },
      });
      this.announce(media.postId);
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
      this.announce(media.postId);
    }
  }

  private announce(postId: string | null): void {
    if (postId) this.transcribed.next(postId);
  }

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
