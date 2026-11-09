import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  ContentModerationService,
  type ContentPart,
} from '../moderation/content-moderation.service.js';
import type { ContentAssessment } from '../moderation/content-decision.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CaptionService } from './captions/caption.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { fetchPublicImage } from '../common/http/fetch-public-image.js';
import {
  CaptionStatus,
  MediaAsset,
  MediaStatus,
  NotificationType,
  Post,
  PostStatus,
  PostType,
} from '../mongo/models.js';
import { StorageService, StorageTarget } from '../storage/storage.service.js';

const STATUS_BY_DECISION: Record<ContentAssessment['decision'], PostStatus> = {
  publish: PostStatus.PUBLISHED,
  review: PostStatus.PENDING_REVIEW,
  reject: PostStatus.REJECTED,
};

const FRAME_COUNT = 4;
const MAX_INLINE_IMAGES = 5;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?[^)]*\)/g;

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
      if (assessment.decision === 'publish') published += 1;
      await this.tellAuthor(post, assessment);
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
    const before = await this.posts
      .findOne({
        _id: id,
        status: { $in: [PostStatus.PENDING_REVIEW, PostStatus.REJECTED] },
      })
      .exec();
    if (!before) return false;
    const now = new Date();
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
        { updatePipeline: true },
      )
      .exec();
    if (result.modifiedCount === 0) return false;
    if (approve) {
      this.captions.schedule();
      await this.notifications.notify({
        recipientId: before.authorId,
        type: NotificationType.POST_APPROVED,
        postId: id,
        note: note ?? undefined,
      });
    } else if (before.status === PostStatus.PENDING_REVIEW) {
      await this.notifications.notify({
        recipientId: before.authorId,
        type: NotificationType.POST_REJECTED,
        postId: id,
        reason: before.moderation?.verdict,
        note: note ?? undefined,
      });
    }
    return true;
  }

  private async tellAuthor(
    post: Post,
    assessment: ContentAssessment,
  ): Promise<void> {
    if (assessment.decision === 'publish') return;
    await this.notifications.notify({
      recipientId: post.authorId,
      type:
        assessment.decision === 'reject'
          ? NotificationType.POST_REJECTED
          : NotificationType.POST_PENDING_REVIEW,
      postId: post.id,
      reason: assessment.category ?? undefined,
    });
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
              moderation: {
                verdict: assessment.category ?? 'allow',
                violationScore: assessment.violationScore,
                scores: assessment.scores,
                checkedAt: now,
                reviewedById: null,
                reviewedAt: null,
                reviewNote: null,
              },
            },
          },
        ],
        { updatePipeline: true },
      )
      .exec();
    if (!published) {
      this.logger.log(
        `Post ${id} ${assessment.decision}: ${assessment.category ?? 'allow'} (${assessment.violationScore.toFixed(2)})`,
      );
    }
    return result.modifiedCount > 0;
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
    const urls: string[] = [];
    if (blog.coverImageUrl) urls.push(blog.coverImageUrl);
    for (const match of blog.content.matchAll(MARKDOWN_IMAGE)) {
      const url = match[1];
      if (url && !urls.includes(url)) urls.push(url);
    }
    const sources = await Promise.all(
      urls
        .slice(0, MAX_INLINE_IMAGES + 1)
        .map((url) => this.downloadImage(url)),
    );
    for (const source of sources) {
      if (source) parts.push({ kind: 'image', source });
    }
    return parts;
  }

  private async downloadImage(url: string): Promise<Buffer | null> {
    const key = this.storage.keyFromPublicUrl(StorageTarget.Blogs, url);
    if (key)
      return Buffer.from(await this.storage.getBytes(StorageTarget.Blogs, key));
    return fetchPublicImage(url);
  }

  private readyVideos(postId: string): Promise<MediaAsset[]> {
    return this.mediaAssets
      .find({ postId, status: MediaStatus.READY, discardedAt: null })
      .sort({ position: 1 })
      .exec();
  }

  private async videoFrames(videos: MediaAsset[]): Promise<ContentPart[]> {
    const frames: Promise<ContentPart>[] = [];
    for (const video of videos) {
      const duration = video.durationSec ?? 0;
      for (let index = 0; index < FRAME_COUNT; index += 1) {
        const seconds = (duration * (index + 0.5)) / FRAME_COUNT;
        frames.push(this.videoFrame(video.publicId, seconds));
      }
    }
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
