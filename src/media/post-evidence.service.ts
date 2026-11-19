import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import type { Model } from 'mongoose';
import { isEnforced } from '../config/moderation-mode.js';
import { runtimeConfig } from '../config/runtime-config.js';
import { ContentEvidenceService } from '../moderation/content-evidence.service.js';
import { routeFlagged } from '../moderation/moderation-route.js';
import { ModerationSettingsService } from '../moderation/moderation-settings.service.js';
import {
  type ModerationRoute,
  Post,
  type PostModeration,
  PostStatus,
  type RouteApplier,
} from '../mongo/models.js';
import { PostModerationService } from './post-moderation.service.js';

const DECIDED = [PostStatus.PENDING_REVIEW, PostStatus.REJECTED];
const HOLD_RETRY_AFTER_MS =
  runtimeConfig.MODERATION_HOLD_RETRY_AFTER_SECONDS * 1000;
const HOLD_RETRY_BATCH = 20;

/** System 1's side of a stored verdict, as the router reads it. */
function classified(moderation: PostModeration) {
  return {
    category: moderation.verdict === 'allow' ? null : moderation.verdict,
    scores: moderation.scores ?? {},
  };
}

/**
 * The reviewer model's pass over a post System 1 flagged. A post held in
 * PROCESSING (MODERATION_MODE=enforce) gets the router's outcome applied;
 * any other flagged post only has the review and the outcome recorded.
 * Runs one post at a time; a post already queued is not queued again.
 */
@Injectable()
export class PostEvidenceService implements OnModuleInit {
  private readonly logger = new Logger(PostEvidenceService.name);
  private queue: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();

  constructor(
    private readonly postModeration: PostModerationService,
    private readonly evidence: ContentEvidenceService,
    private readonly settings: ModerationSettingsService,
    private readonly config: ConfigService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
  ) {}

  onModuleInit(): void {
    this.postModeration.flagged.subscribe((postId) => this.enqueue(postId));
  }

  private enqueue(postId: string): void {
    if (this.queued.has(postId)) return;
    this.queued.add(postId);
    this.queue = this.queue.then(async () => {
      this.queued.delete(postId);
      await this.explainInBackground(postId);
    });
  }

  private async explainInBackground(postId: string): Promise<void> {
    try {
      await this.explain(postId);
    } catch (error) {
      this.logger.warn(`Reviewing post ${postId} failed: ${String(error)}`);
    }
  }

  /** Requeues held posts whose review was lost (a restart, a crash). */
  @Cron(runtimeConfig.MEDIA_MODERATION_RETRY_CRON)
  async retryHeld(): Promise<void> {
    const stale = await this.posts
      .find({
        status: PostStatus.PROCESSING,
        'moderation.heldAt': {
          $lt: new Date(Date.now() - HOLD_RETRY_AFTER_MS),
        },
      })
      .select('_id')
      .sort({ 'moderation.heldAt': 1, _id: 1 })
      .limit(HOLD_RETRY_BATCH)
      .exec();
    for (const { id } of stale) this.enqueue(id);
  }

  /**
   * Reviews a flagged post: held (PROCESSING), PENDING_REVIEW or REJECTED.
   * False when there is no such post, or it was judged again meanwhile.
   */
  async explain(postId: string): Promise<boolean> {
    const post = await this.posts
      .findOne({
        _id: postId,
        moderation: { $ne: null },
        $or: [
          { status: { $in: DECIDED } },
          { status: PostStatus.PROCESSING, 'moderation.heldAt': { $ne: null } },
        ],
      })
      .exec();
    if (!post?.moderation) return false;
    const moderation = post.moderation;
    const review = await this.evidence.explain(() =>
      this.postModeration.evidenceSources(post),
    );
    const { manipulationThreshold } = await this.settings.get();
    const routed = routeFlagged(
      classified(moderation),
      review,
      manipulationThreshold,
    );

    if (post.status === PostStatus.PROCESSING) {
      return this.postModeration.finishReview(post, review, routed);
    }

    const update: Record<string, unknown> = { 'moderation.evidence': review };
    // Keep the record of an outcome that was applied; a rerun only advises.
    if (!moderation.route?.appliedBy) {
      const route: ModerationRoute = {
        ...routed,
        appliedBy: this.appliedBySystemOne(post.status, routed.rule),
        decidedAt: new Date(),
      };
      update['moderation.route'] = route;
    }
    const result = await this.posts
      .updateOne(
        { _id: postId, 'moderation.checkedAt': moderation.checkedAt },
        { $set: update },
      )
      .exec();
    return result.modifiedCount > 0;
  }

  /** Under enforce, System 1 itself settles manipulation and refused content. */
  private appliedBySystemOne(
    status: PostStatus,
    rule: ModerationRoute['rule'],
  ): RouteApplier | null {
    if (!isEnforced(this.config)) return null;
    if (rule === 'MANIPULATION' && status === PostStatus.REJECTED) {
      return 'SYSTEM_ONE';
    }
    if (rule === 'PROVIDER_BLOCKED' && status === PostStatus.PENDING_REVIEW) {
      return 'SYSTEM_ONE';
    }
    return null;
  }
}
