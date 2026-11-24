import { runtimeConfig } from '../config/runtime-config.js';
import {
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { SupportSyncService } from '../support/support-sync.service.js';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { ContentModerationService } from '../moderation/content-moderation.service.js';
import {
  type ContentAssessment,
  failedAssessment,
} from '../moderation/content-decision.js';
import type {
  EvidenceImage,
  EvidenceSources,
  EvidenceText,
} from '../moderation/content-evidence.js';
import { toModerationJpeg } from '../moderation/moderation-image.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CaptionService } from './captions/caption.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { fetchPublicImage } from '../common/http/fetch-public-image.js';
import { extractMarkdownMediaUrls } from '../common/text.js';
import {
  AppealOutcome,
  CaptionStatus,
  MediaAsset,
  MediaStatus,
  NotificationType,
  Post,
  PostStatus,
  PostType,
  type SupportTicket,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { StorageService, StorageTarget } from '../storage/storage.service.js';
import { type FrameSampling, videoFrameTimes } from './video-frame-times.js';

const STATUS_BY_DECISION: Record<ContentAssessment['decision'], PostStatus> = {
  publish: PostStatus.PUBLISHED,
  review: PostStatus.PENDING_REVIEW,
  reject: PostStatus.REJECTED,
};


const FRAME_SAMPLING: FrameSampling = {
  intervalSeconds: runtimeConfig.MODERATION_VIDEO_FRAME_INTERVAL_SECONDS,
  minPerVideo: runtimeConfig.MODERATION_VIDEO_MIN_FRAMES,
  maxPerPost: runtimeConfig.MODERATION_VIDEO_MAX_FRAMES,
};
const MAX_INLINE_IMAGES = runtimeConfig.MODERATION_MAX_INLINE_IMAGES;

@Injectable()
export class PostModerationService implements OnModuleInit {
  private readonly logger = new Logger(PostModerationService.name);

  constructor(
    private readonly moderation: ContentModerationService,
    private readonly cloudinary: CloudinaryService,
    private readonly storage: StorageService,
    private readonly captions: CaptionService,
    private readonly notifications: NotificationsService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(MediaAsset.name)
    private readonly mediaAssets: Model<MediaAsset>,
    @Optional() private readonly mongo?: MongoService,
    @Optional() private readonly supportSync?: SupportSyncService,
  ) {}

  onModuleInit(): void {
    this.captions.transcribed.subscribe((postId) => {
      void this.settleAfterTranscript(postId);
    });
  }

  private async settleAfterTranscript(postId: string): Promise<void> {
    try {
      const published = await this.settle([postId]);
      if (published > 0) this.captions.schedule();
    } catch (error) {
      this.logger.warn(
        `Moderating post ${postId} after its transcript failed: ${String(error)}`,
      );
    }
  }

  async settle(postIds: string[]): Promise<number> {
    let published = 0;
    for (const id of postIds) {
      const judged = await this.judge(id);
      if (judged === null) continue;
      const { post, assessment } = judged;
      const settled = await this.apply(post.id, assessment);
      if (!settled) continue;
      if (assessment.decision === 'publish') {
        published += 1;
        continue;
      }
      await this.tellAuthor(post, assessment.decision, assessment.category);
    }
    return published;
  }

  async decide(
    id: string,
    adminId: string,
    decision: 'APPROVE' | 'REJECT',
    note: string | null,
  ): Promise<boolean> {
    const approve = decision === 'APPROVE';
    const now = new Date();
    let before: Post | null = null;
    let closedAppeal: SupportTicket | null = null;

    const runUpdate = async (session?: ClientSession): Promise<boolean> => {
      const findQuery = this.posts.findOne({
        _id: id,
        status: { $in: [PostStatus.PENDING_REVIEW, PostStatus.REJECTED] },
      });
      if (session) findQuery.session(session);
      before = await findQuery.exec();
      if (!before) return false;
      const updateOptions = session
        ? { updatePipeline: true, session }
        : { updatePipeline: true };
      const result = await this.posts
        .updateOne(
          { _id: id, status: before.status },
          [
            {
              $set: {
                status: approve ? PostStatus.PUBLISHED : PostStatus.REJECTED,
                publishedAt: approve
                  ? { $ifNull: ['$publishedAt', now] }
                  : '$publishedAt',
                'moderation.reviewedById': adminId,
                'moderation.reviewedAt': now,
                'moderation.reviewNote': note,
              },
            },
          ],
          updateOptions,
        )
        .exec();
      if (result.modifiedCount === 0) return false;
      if (approve && this.supportSync && session) {
        closedAppeal = await this.supportSync.closeActiveAppealOnAdminAction(
          session,
          {
            postId: id,
            adminId,
            outcome: AppealOutcome.APPROVED,
            note,
            now,
          },
        );
      }
      return true;
    };

    const modified =
      this.mongo && this.supportSync && approve
        ? await this.mongo.withTransaction((session) => runUpdate(session))
        : await runUpdate();

    if (!modified || !before) return false;
    const decidedPost: Post = before;
    if (approve) {
      this.captions.schedule();
      if (closedAppeal !== null) {
        const closed: SupportTicket = closedAppeal;
        await this.notifications.notify({
          recipientId: decidedPost.authorId,
          type: NotificationType.SUPPORT_TICKET_RESOLVED,
          postId: id,
          ticketId: closed.id,
          reason: 'APPEAL_APPROVED',
          note: note ?? undefined,
        });
      } else {
        await this.notifications.notify({
          recipientId: decidedPost.authorId,
          type: NotificationType.POST_APPROVED,
          postId: id,
          note: note ?? undefined,
        });
      }
    } else if (decidedPost.status !== PostStatus.REJECTED) {
      await this.notifications.notify({
        recipientId: decidedPost.authorId,
        type: NotificationType.POST_REJECTED,
        postId: id,
        reason: decidedPost.moderation?.verdict,
        note: note ?? undefined,
      });
    }
    return true;
  }

  private async tellAuthor(
    post: Post,
    decision: ContentAssessment['decision'],
    category: string | null,
  ): Promise<void> {
    if (decision === 'publish') return;
    await this.notifications.notify({
      recipientId: post.authorId,
      type:
        decision === 'reject'
          ? NotificationType.POST_REJECTED
          : NotificationType.POST_PENDING_REVIEW,
      postId: post.id,
      reason: category ?? undefined,
    });
  }

  /**
   * The post's verdict, or null when it is not PROCESSING or still waits for
   * a transcript. A failure to load or rate it holds it for an admin.
   */
  private async judge(
    id: string,
  ): Promise<{ post: Post; assessment: ContentAssessment } | null> {
    const post = await this.posts
      .findOne({ _id: id, status: PostStatus.PROCESSING })
      .exec();
    if (!post) return null;
    try {
      const sources = await this.sourcesOf(post);
      if (sources === null) return null;
      return { post, assessment: await this.moderation.review(sources) };
    } catch (error) {
      this.logger.warn(
        `Moderating post ${id} failed, holding it for an admin: ${String(error)}`,
      );
      return { post, assessment: failedAssessment(this.moderation.modelId) };
    }
  }

  private async apply(
    id: string,
    assessment: ContentAssessment,
  ): Promise<boolean> {
    const now = new Date();
    const status = STATUS_BY_DECISION[assessment.decision];
    const published = status === PostStatus.PUBLISHED;
    const result = await this.posts
      .updateOne(
        { _id: id, status: PostStatus.PROCESSING },
        [
          {
            $set: {
              status,
              publishedAt: published
                ? { $ifNull: ['$publishedAt', now] }
                : '$publishedAt',
              // Quotes come from members: never read them as expressions.
              moderation: {
                $literal: {
                  verdict: assessment.category ?? 'allow',
                  riskLevel: assessment.riskLevel,
                  checkedAt: now,
                  reviewedById: null,
                  reviewedAt: null,
                  reviewNote: null,
                  evidence: assessment.evidence,
                },
              },
            },
          },
        ],
        { updatePipeline: true },
      )
      .exec();
    if (!published) {
      this.logger.log(
        `Post ${id} ${assessment.decision}: ${assessment.category ?? 'allow'} (risk ${assessment.riskLevel ?? 'none'})`,
      );
    }
    return result.modifiedCount > 0;
  }

  /**
   * The text and pictures the reviewer rates, labelled with where each came
   * from. Null while a video still waits for its transcript.
   */
  private async sourcesOf(post: Post): Promise<EvidenceSources | null> {
    if (post.type === PostType.BLOG) return this.blogSources(post);
    const videos = await this.readyVideos(post.id);
    if (this.awaitingTranscript(videos)) {
      this.captions.schedule();
      return null;
    }
    const texts: EvidenceText[] = [];
    if (post.body) {
      texts.push({ field: 'body', mediaId: null, text: post.body });
    }
    texts.push(...this.transcripts(videos));
    return { texts, images: await this.videoFrames(videos) };
  }

  private awaitingTranscript(videos: MediaAsset[]): boolean {
    if (!this.captions.active) return false;
    return videos.some(
      (video) =>
        video.transcript === null &&
        (video.captionStatus === CaptionStatus.NONE ||
          video.captionStatus === CaptionStatus.TRANSCRIBING),
    );
  }

  private transcripts(videos: MediaAsset[]): EvidenceText[] {
    const texts: EvidenceText[] = [];
    for (const video of videos) {
      if (video.captionStatus === CaptionStatus.FAILED) {
        this.logger.warn(
          `Media ${video.id} has no transcript to moderate: captioning failed`,
        );
      }
      if (video.transcript) {
        texts.push({
          field: 'transcript',
          mediaId: video.id,
          text: video.transcript,
        });
      }
    }
    return texts;
  }

  private async videoFrames(videos: MediaAsset[]): Promise<EvidenceImage[]> {
    const times = videoFrameTimes(
      videos.map((video) => video.durationSec ?? 0),
      FRAME_SAMPLING,
    );
    const frames: Promise<EvidenceImage>[] = [];
    videos.forEach((video, index) => {
      for (const seconds of times[index]) {
        frames.push(this.videoFrame(video, seconds));
      }
    });
    return Promise.all(frames);
  }

  private async videoFrame(
    video: MediaAsset,
    seconds: number,
  ): Promise<EvidenceImage> {
    const url = this.cloudinary.frameUrl(video.publicId, seconds);
    const jpeg = await fetchPublicImage(url);
    if (!jpeg) throw new Error(`No frame at ${seconds}s of ${video.publicId}`);
    return { field: 'frame', jpeg, mediaId: video.id, seconds, url };
  }

  private async blogSources(post: Post): Promise<EvidenceSources> {
    const blog = post.blog;
    if (!blog) return { texts: [], images: [] };
    const texts: EvidenceText[] = [
      { field: 'title', mediaId: null, text: blog.title },
      { field: 'content', mediaId: null, text: blog.content },
    ];
    const images: EvidenceImage[] = [];
    for (const url of this.blogImageUrls(blog.coverImageUrl, blog.content)) {
      const source = await this.downloadImage(url);
      if (!source) continue;
      images.push({
        field: 'image',
        jpeg: await toModerationJpeg(source),
        mediaId: null,
        seconds: null,
        url,
      });
    }
    return { texts, images };
  }

  /** The cover and up to MAX_INLINE_IMAGES images of ours in the content. */
  private blogImageUrls(
    coverImageUrl: string | null,
    content: string,
  ): string[] {
    const urls: string[] = [];
    if (coverImageUrl) urls.push(coverImageUrl);
    for (const url of extractMarkdownMediaUrls(content)) {
      if (
        !urls.includes(url) &&
        this.storage.keyFromPublicUrl(StorageTarget.Blogs, url) !== null
      ) {
        urls.push(url);
      }
    }
    return urls.slice(0, MAX_INLINE_IMAGES + 1);
  }

  private async downloadImage(url: string): Promise<Buffer | null> {
    const key = this.storage.keyFromPublicUrl(StorageTarget.Blogs, url);
    if (!key) return null;
    return Buffer.from(await this.storage.getBytes(StorageTarget.Blogs, key));
  }

  private readyVideos(postId: string): Promise<MediaAsset[]> {
    return this.mediaAssets
      .find({ postId, status: MediaStatus.READY, discardedAt: null })
      .sort({ position: 1 })
      .exec();
  }
}
