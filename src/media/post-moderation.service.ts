import { runtimeConfig } from '../config/runtime-config.js';
import {
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupportSyncService } from '../support/support-sync.service.js';
import { isEnforced } from '../config/moderation-mode.js';
import { PROVIDER_BLOCKED_KEY } from '../moderation/content-decision.js';
import { MANIPULATION_KEY } from '../moderation/policies/content.js';
import type { RoutedVerdict } from '../moderation/moderation-route.js';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { Subject } from 'rxjs';
import {
  ContentModerationService,
  type ContentPart,
} from '../moderation/content-moderation.service.js';
import type { ContentAssessment } from '../moderation/content-decision.js';
import type {
  EvidenceImage,
  EvidenceSources,
  EvidenceText,
} from '../moderation/content-evidence.js';
import { toJevJpeg } from '../moderation/moderation-image.js';
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
  type ModerationEvidence,
  type RouteOutcome,
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

const STATUS_BY_OUTCOME: Record<RouteOutcome, PostStatus> = {
  PUBLISH: PostStatus.PUBLISHED,
  REJECT: PostStatus.REJECTED,
  ADMIN: PostStatus.PENDING_REVIEW,
};

const DECISION_BY_OUTCOME: Record<RouteOutcome, ContentAssessment['decision']> =
  {
    PUBLISH: 'publish',
    REJECT: 'reject',
    ADMIN: 'review',
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
  /** Ids of posts the classifier just held for review or rejected. */
  readonly flagged = new Subject<string>();

  constructor(
    private readonly moderation: ContentModerationService,
    private readonly cloudinary: CloudinaryService,
    private readonly storage: StorageService,
    private readonly captions: CaptionService,
    private readonly notifications: NotificationsService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(MediaAsset.name)
    private readonly mediaAssets: Model<MediaAsset>,
    private readonly config: ConfigService,
    @Optional() private readonly mongo?: MongoService,
    @Optional() private readonly supportSync?: SupportSyncService,
  ) {}

  /**
   * Under enforce, a flagged post waits in PROCESSING for the reviewer model,
   * except what System 1 settles for good: the manipulation rule and content
   * the provider refused to read (an admin's call).
   */
  private holdsForReview(assessment: ContentAssessment): boolean {
    if (!isEnforced(this.config)) return false;
    if (assessment.decision === 'publish') return false;
    if (assessment.category === PROVIDER_BLOCKED_KEY) return false;
    const manipulation =
      assessment.decision === 'reject' &&
      assessment.category === MANIPULATION_KEY;
    return !manipulation;
  }

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
      const held = this.holdsForReview(assessment);
      const settled = await this.apply(post.id, assessment, held);
      if (!settled) continue;
      if (assessment.decision === 'publish') {
        published += 1;
        continue;
      }
      this.flagged.next(post.id);
      // A held post's author hears once, when the reviewer has decided.
      if (!held) {
        await this.tellAuthor(post, assessment.decision, assessment.category);
      }
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
    const decidable: Record<string, unknown>[] = [
      { status: { $in: [PostStatus.PENDING_REVIEW, PostStatus.REJECTED] } },
    ];
    // An admin can take down what the reviewer model let through.
    if (!approve) {
      decidable.push({
        status: PostStatus.PUBLISHED,
        'moderation.route.appliedBy': 'SYSTEM_TWO',
      });
    }
    const now = new Date();
    let before: Post | null = null;
    let closedAppeal: SupportTicket | null = null;

    const runUpdate = async (session?: ClientSession): Promise<boolean> => {
      const findQuery = this.posts.findOne({ _id: id, $or: decidable });
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
   * Applies the router's outcome to a post held for the reviewer model, then
   * tells the author once. False when the post was judged again or left
   * PROCESSING meanwhile: that newer verdict gets its own review.
   */
  async finishReview(
    post: Post,
    evidence: ModerationEvidence,
    routed: RoutedVerdict,
  ): Promise<boolean> {
    if (!post.moderation?.heldAt) return false;
    const now = new Date();
    const status = STATUS_BY_OUTCOME[routed.outcome];
    const published = status === PostStatus.PUBLISHED;
    const route = { ...routed, appliedBy: 'SYSTEM_TWO', decidedAt: now };
    const result = await this.posts
      .updateOne(
        {
          _id: post.id,
          status: PostStatus.PROCESSING,
          'moderation.checkedAt': post.moderation.checkedAt,
          'moderation.heldAt': { $ne: null },
        },
        [
          {
            $set: {
              status,
              publishedAt: published
                ? { $ifNull: ['$publishedAt', now] }
                : '$publishedAt',
              // Quotes come from members: never read them as expressions.
              'moderation.evidence': { $literal: evidence },
              'moderation.route': { $literal: route },
              'moderation.heldAt': null,
            },
          },
        ],
        { updatePipeline: true },
      )
      .exec();
    if (result.modifiedCount === 0) return false;
    this.logger.log(
      `Post ${post.id} ${routed.outcome} by the reviewer (${routed.rule})`,
    );
    if (published) this.captions.schedule();
    await this.tellAuthor(
      post,
      DECISION_BY_OUTCOME[routed.outcome],
      routed.category,
    );
    return true;
  }

  private async judge(
    id: string,
  ): Promise<{ post: Post; assessment: ContentAssessment } | null> {
    const post = await this.posts
      .findOne({ _id: id, status: PostStatus.PROCESSING })
      .exec();
    if (!post) return null;
    try {
      const parts = await this.partsOf(post);
      if (parts === null) return null;
      return { post, assessment: await this.moderation.review(parts) };
    } catch (error) {
      this.logger.warn(
        `Moderating post ${id} failed, it stays PROCESSING: ${String(error)}`,
      );
      return null;
    }
  }

  private async apply(
    id: string,
    assessment: ContentAssessment,
    held: boolean,
  ): Promise<boolean> {
    const now = new Date();
    const status = held
      ? PostStatus.PROCESSING
      : STATUS_BY_DECISION[assessment.decision];
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
              moderation: {
                verdict: assessment.category ?? 'allow',
                violationScore: assessment.violationScore,
                scores: assessment.scores,
                checkedAt: now,
                reviewedById: null,
                reviewedAt: null,
                reviewNote: null,
                evidence: null,
                route: null,
                heldAt: held ? now : null,
              },
            },
          },
        ],
        { updatePipeline: true },
      )
      .exec();
    if (!published) {
      const verb = held ? 'held for the reviewer' : assessment.decision;
      this.logger.log(
        `Post ${id} ${verb}: ${assessment.category ?? 'allow'} (${assessment.violationScore.toFixed(2)})`,
      );
    }
    return result.modifiedCount > 0;
  }

  /**
   * The same text and pictures the classifier judged, labelled with where each
   * came from, for the explainer. Frames are taken at the same seconds.
   */
  async evidenceSources(post: Post): Promise<EvidenceSources> {
    if (post.type === PostType.BLOG) return this.blogEvidence(post);
    const videos = await this.readyVideos(post.id);
    const texts: EvidenceText[] = [];
    if (post.body)
      texts.push({ field: 'body', mediaId: null, text: post.body });
    for (const video of videos) {
      if (video.transcript) {
        texts.push({
          field: 'transcript',
          mediaId: video.id,
          text: video.transcript,
        });
      }
    }
    const times = videoFrameTimes(
      videos.map((video) => video.durationSec ?? 0),
      FRAME_SAMPLING,
    );
    const frames: Promise<EvidenceImage>[] = [];
    videos.forEach((video, index) => {
      for (const seconds of times[index]) {
        frames.push(this.evidenceFrame(video, seconds));
      }
    });
    return { texts, images: await Promise.all(frames) };
  }

  private async evidenceFrame(
    video: MediaAsset,
    seconds: number,
  ): Promise<EvidenceImage> {
    const url = this.cloudinary.frameUrl(video.publicId, seconds);
    const jpeg = await fetchPublicImage(url);
    if (!jpeg) throw new Error(`No frame at ${seconds}s of ${video.publicId}`);
    return { field: 'frame', jpeg, mediaId: video.id, seconds, url };
  }

  private async blogEvidence(post: Post): Promise<EvidenceSources> {
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
        jpeg: await toJevJpeg(source),
        mediaId: null,
        seconds: null,
        url,
      });
    }
    return { texts, images };
  }

  private async partsOf(post: Post): Promise<ContentPart[] | null> {
    if (post.type === PostType.BLOG) return this.blogParts(post);
    const videos = await this.readyVideos(post.id);
    if (this.awaitingTranscript(videos)) {
      this.captions.schedule();
      return null;
    }
    const parts: ContentPart[] = [{ kind: 'text', text: post.body ?? '' }];
    parts.push(...(await this.videoFrames(videos)));
    parts.push(...this.transcripts(videos));
    return parts;
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

  private transcripts(videos: MediaAsset[]): ContentPart[] {
    const parts: ContentPart[] = [];
    for (const video of videos) {
      if (video.captionStatus === CaptionStatus.FAILED) {
        this.logger.warn(
          `Media ${video.id} has no transcript to moderate: captioning failed`,
        );
      }
      if (video.transcript) {
        parts.push({
          kind: 'text',
          text: `What the video says: ${video.transcript}`,
        });
      }
    }
    return parts;
  }

  private async blogParts(post: Post): Promise<ContentPart[]> {
    const blog = post.blog;
    if (!blog) return [];
    const parts: ContentPart[] = [
      { kind: 'text', text: blog.title },
      { kind: 'text', text: blog.content },
    ];
    const sources = await Promise.all(
      this.blogImageUrls(blog.coverImageUrl, blog.content).map((url) =>
        this.downloadImage(url),
      ),
    );
    for (const source of sources) {
      if (source) parts.push({ kind: 'image', source });
    }
    return parts;
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

  private async videoFrames(videos: MediaAsset[]): Promise<ContentPart[]> {
    const times = videoFrameTimes(
      videos.map((video) => video.durationSec ?? 0),
      FRAME_SAMPLING,
    );
    const frames: Promise<ContentPart>[] = [];
    videos.forEach((video, index) => {
      for (const seconds of times[index]) {
        frames.push(this.videoFrame(video.publicId, seconds));
      }
    });
    return Promise.all(frames);
  }

  private async videoFrame(
    publicId: string,
    seconds: number,
  ): Promise<ContentPart> {
    const source = await fetchPublicImage(
      this.cloudinary.frameUrl(publicId, seconds),
    );
    if (!source) throw new Error(`No frame at ${seconds}s of ${publicId}`);
    return { kind: 'jpeg', source };
  }
}
