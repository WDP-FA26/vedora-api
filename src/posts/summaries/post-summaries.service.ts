import { createHash, randomUUID } from 'node:crypto';
import { runtimeConfig } from '../../config/runtime-config.js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, PipelineStage } from 'mongoose';
import { aiCostContext } from '../../ai/telemetry/ai-cost-context.js';
import { CaptionService } from '../../media/captions/caption.service.js';
import { ContentModerationService } from '../../moderation/content-moderation.service.js';
import { UnprocessableContentException } from '../../common/exceptions/unprocessable-content.exception.js';
import { isUniqueViolation } from '../../mongo/errors.js';
import { MongoService } from '../../mongo/mongo.service.js';
import {
  CaptionStatus,
  MediaAsset,
  MediaStatus,
  Post,
  PostComment,
  PostStatus,
  PostSummary,
  PostSummaryStatus,
  type SummaryRecipe,
  User,
} from '../../mongo/models.js';
import { MAX_COMMENT_BODY_LENGTH } from '../dto/comment.dto.js';
import {
  SYSTEM_ACCOUNT,
  SYSTEM_ACCOUNT_ID,
} from '../../users/system-account.js';
import {
  PostSummaryGenerator,
  type SummaryOutput,
  type SummarySourcePart,
} from './post-summary.generator.js';
import { formatSummaryComment } from './summary-comment.js';
import { readPostSource, type PostSource } from './post-source.js';

const BATCH_SIZE = runtimeConfig.POST_SUMMARY_BATCH_SIZE;
const MAX_ATTEMPTS = runtimeConfig.POST_SUMMARY_MAX_ATTEMPTS;
const MIN_TEXT_LENGTH = runtimeConfig.POST_SUMMARY_MIN_TEXT_LENGTH;
const STALE_AFTER_MS = runtimeConfig.POST_SUMMARY_STALE_AFTER_SECONDS * 1000;
const WINDOW_MS = runtimeConfig.POST_SUMMARY_WINDOW_SECONDS * 1000;
const MAX_ERROR_LENGTH = 500;

/** Thrown inside the comment transaction when another run took the claim over. */
class ClaimLostError extends Error {}

interface Claim {
  id: string;
  postId: string;
  claimedAt: Date;
  attempts: number;
}

@Injectable()
export class PostSummariesService {
  private readonly logger = new Logger(PostSummariesService.name);
  private readonly enabled: boolean;
  private draining: Promise<void> | null = null;
  /** Set once the Vedora AI account is known to exist; checked again after a restart. */
  private systemAccountReady = false;
  private systemAccountConflictLogged = false;
  /** The posts last reported as waiting for transcripts, to log only changes. */
  private waitingKey = '';

  constructor(
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(PostComment.name)
    private readonly comments: Model<PostComment>,
    @InjectModel(PostSummary.name)
    private readonly summaries: Model<PostSummary>,
    @InjectModel(MediaAsset.name)
    private readonly mediaAssets: Model<MediaAsset>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly mongo: MongoService,
    private readonly captions: CaptionService,
    private readonly generator: PostSummaryGenerator,
    private readonly moderation: ContentModerationService,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('POST_SUMMARIES_ENABLED', true);
  }

  @Cron(runtimeConfig.POST_SUMMARY_CRON)
  async advance(): Promise<void> {
    if (!this.enabled || this.draining) return;
    this.draining = this.drain()
      .catch((error: unknown) => {
        this.logger.warn(`Summarizing posts failed: ${String(error)}`);
      })
      .finally(() => {
        this.draining = null;
      });
    await this.draining;
  }

  /** Summarizes recently published posts that have no summary yet, and retries stale claims. */
  async drain(): Promise<void> {
    if (!this.systemAccountReady) {
      this.systemAccountReady = await this.ensureSystemAccount();
    }
    if (!this.systemAccountReady) return;
    await this.failExhausted();
    for (const claim of await this.reclaimStale()) {
      await this.process(claim);
    }
    if (this.captions.active) await this.logWaiting();
    let found: number;
    do {
      const postIds = await this.unsummarizedPostIds();
      found = postIds.length;
      for (const postId of postIds) {
        const claim = await this.claim(postId);
        if (claim) await this.process(claim);
      }
    } while (found === BATCH_SIZE);
  }

  findForPost(postId: string): Promise<PostSummary | null> {
    return this.summaries.findOne({ postId }).exec();
  }

  /**
   * Creates the Vedora AI account if it is missing and re-asserts what keeps
   * it unusable for sign-in. False when its username is taken by a member.
   */
  async ensureSystemAccount(): Promise<boolean> {
    try {
      await this.users.updateOne(
        { _id: SYSTEM_ACCOUNT_ID },
        {
          $set: {
            status: SYSTEM_ACCOUNT.status,
            passwordHash: null,
            googleId: null,
            emailVerifiedAt: null,
          },
          $setOnInsert: {
            username: SYSTEM_ACCOUNT.username,
            fullName: SYSTEM_ACCOUNT.fullName,
            email: SYSTEM_ACCOUNT.email,
            role: SYSTEM_ACCOUNT.role,
            isProfessional: SYSTEM_ACCOUNT.isProfessional,
            accountVersion: 0,
            avoidedIngredientIds: [],
            avoidedGroupIds: [],
          },
        },
        { upsert: true },
      );
      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Retried on every run, but reported once so the log is not flooded.
      if (!this.systemAccountConflictLogged) {
        this.systemAccountConflictLogged = true;
        this.logger.error(
          `Cannot create the Vedora AI account: username "${SYSTEM_ACCOUNT.username}" or its email is taken`,
        );
      }
      return false;
    }
  }

  /** Recently published posts that have no summary row yet. */
  private unsummarizedStages(): PipelineStage[] {
    return [
      {
        $match: {
          status: PostStatus.PUBLISHED,
          publishedAt: { $gte: new Date(Date.now() - WINDOW_MS) },
        },
      },
      {
        $lookup: {
          from: this.summaries.collection.name,
          localField: '_id',
          foreignField: 'postId',
          as: 'summary',
        },
      },
      { $match: { summary: { $size: 0 } } },
      {
        $lookup: {
          from: this.mediaAssets.collection.name,
          let: { postId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$postId', '$$postId'] },
                status: MediaStatus.READY,
                discardedAt: null,
                transcript: null,
                captionStatus: {
                  $in: [CaptionStatus.NONE, CaptionStatus.TRANSCRIBING],
                },
              },
            },
            { $project: { _id: 1, captionStatus: 1 } },
          ],
          as: 'untranscribed',
        },
      },
    ];
  }

  /** Recently published posts with no summary row, whose videos are transcribed. */
  private async unsummarizedPostIds(): Promise<string[]> {
    const pipeline = this.unsummarizedStages();
    // Without captions no transcript is coming, so nothing waits for one.
    if (this.captions.active) {
      pipeline.push({ $match: { untranscribed: { $size: 0 } } });
    }
    pipeline.push(
      { $sort: { publishedAt: 1, _id: 1 } },
      { $limit: BATCH_SIZE },
      { $project: { _id: 1 } },
    );
    const rows = await this.posts.aggregate<{ _id: string }>(pipeline).exec();
    return rows.map((row) => row._id);
  }

  /** Logs the posts held back for their videos' transcripts, when that list changes. */
  private async logWaiting(): Promise<void> {
    const pipeline = this.unsummarizedStages();
    pipeline.push(
      { $match: { 'untranscribed.0': { $exists: true } } },
      { $sort: { publishedAt: 1, _id: 1 } },
      { $limit: BATCH_SIZE },
      { $project: { _id: 1, untranscribed: 1 } },
    );
    const rows = await this.posts
      .aggregate<{
        _id: string;
        untranscribed: { _id: string; captionStatus: CaptionStatus }[];
      }>(pipeline)
      .exec();
    const entries: string[] = [];
    for (const row of rows) {
      const videos: string[] = [];
      for (const video of row.untranscribed) {
        videos.push(`video ${video._id} ${video.captionStatus}`);
      }
      entries.push(`post ${row._id} (${videos.join(', ')})`);
    }
    const key = entries.join('; ');
    if (key === this.waitingKey) return;
    this.waitingKey = key;
    if (entries.length === 0) return;
    this.logger.log(`Waiting for transcripts: ${key}`);
  }

  private async claim(postId: string): Promise<Claim | null> {
    const claimedAt = new Date();
    try {
      const created = await this.summaries.create({
        postId,
        status: PostSummaryStatus.PENDING,
        attempts: 1,
        claimedAt,
      });
      return { id: created.id, postId, claimedAt, attempts: 1 };
    } catch (error) {
      // Another run claimed it first.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  private async reclaimStale(): Promise<Claim[]> {
    const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
    const stale = await this.summaries
      .find({
        status: PostSummaryStatus.PENDING,
        claimedAt: { $lt: staleBefore },
        attempts: { $lt: MAX_ATTEMPTS },
      })
      .sort({ claimedAt: 1, _id: 1 })
      .limit(BATCH_SIZE)
      .exec();
    const claims: Claim[] = [];
    for (const row of stale) {
      const claimedAt = new Date();
      const taken = await this.summaries
        .findOneAndUpdate(
          {
            _id: row.id,
            status: PostSummaryStatus.PENDING,
            claimedAt: row.claimedAt,
          },
          { $set: { claimedAt }, $inc: { attempts: 1 } },
          { returnDocument: 'after' },
        )
        .exec();
      if (!taken) continue;
      claims.push({
        id: taken.id,
        postId: taken.postId,
        claimedAt,
        attempts: taken.attempts,
      });
    }
    return claims;
  }

  private async failExhausted(): Promise<void> {
    await this.summaries.updateMany(
      {
        status: PostSummaryStatus.PENDING,
        claimedAt: { $lt: new Date(Date.now() - STALE_AFTER_MS) },
        attempts: { $gte: MAX_ATTEMPTS },
      },
      { $set: { status: PostSummaryStatus.FAILED } },
    );
  }

  private async process(claim: Claim): Promise<void> {
    const attempt = `attempt ${claim.attempts}/${MAX_ATTEMPTS}`;
    try {
      const post = await this.posts
        .findOne({ _id: claim.postId, status: PostStatus.PUBLISHED })
        .exec();
      if (!post) {
        this.logger.log(`Post ${claim.postId} skipped: no longer published`);
        await this.finish(claim, { status: PostSummaryStatus.SKIPPED });
        return;
      }
      const source = await this.sourceOf(post);
      const sourceHash = hashParts(source.parts);
      const length = textLength(source.parts);
      if (length < MIN_TEXT_LENGTH) {
        this.logger.log(
          `Post ${post.id} skipped: too short (${length} < ${MIN_TEXT_LENGTH} chars; ${source.description})`,
        );
        await this.finish(claim, {
          status: PostSummaryStatus.SKIPPED,
          sourceHash,
        });
        return;
      }
      this.logger.log(
        `Summarizing post ${post.id} (${attempt}; ${source.description})`,
      );
      const startedAt = Date.now();
      const output = await this.generate(post, source.parts);
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const summary = output.summary.trim();
      if (!output.worthSummarizing || !summary) {
        this.logger.log(
          `Post ${post.id} skipped after ${seconds}s: the model found nothing to summarize`,
        );
        await this.finish(claim, {
          status: PostSummaryStatus.SKIPPED,
          sourceHash,
          model: this.generator.modelId,
        });
        return;
      }
      const recipe = cleanRecipe(output.recipe);
      const commentId = await this.publish(claim, {
        sourceHash,
        language: normalizeLanguage(output.language),
        summary,
        recipe,
      });
      if (commentId === undefined) return;
      this.logger.log(
        `Post ${post.id} summarized in ${seconds}s by ${this.generator.modelId}: ${describeRecipe(recipe)}, comment ${commentId ?? 'not posted'}`,
      );
    } catch (error) {
      if (error instanceof ClaimLostError) {
        this.logger.warn(
          `Post ${claim.postId}: another run took the summary over; this result was dropped`,
        );
        return;
      }
      const message = String(error).slice(0, MAX_ERROR_LENGTH);
      const exhausted = claim.attempts >= MAX_ATTEMPTS;
      if (exhausted) {
        this.logger.error(
          `Summarizing post ${claim.postId} failed (${attempt}), giving up: ${message}`,
        );
      } else {
        this.logger.warn(
          `Summarizing post ${claim.postId} failed (${attempt}), retrying after ${STALE_AFTER_MS / 1000}s: ${message}`,
        );
      }
      await this.summaries.updateOne(
        { _id: claim.id, claimedAt: claim.claimedAt },
        {
          $set: {
            error: message,
            ...(exhausted && { status: PostSummaryStatus.FAILED }),
          },
        },
      );
    }
  }

  private generate(
    post: Post,
    parts: SummarySourcePart[],
  ): Promise<SummaryOutput> {
    const executionId = randomUUID();
    return aiCostContext.run(
      {
        feature: 'POSTS',
        userId: post.authorId,
        executionId,
        turnId: executionId,
      },
      () => this.generator.generate(parts),
    );
  }

  /**
   * Stores the summary and posts its comment together, or neither. Returns
   * the comment id (null when the post left PUBLISHED meanwhile), or
   * undefined when moderation turned the comment away.
   */
  private async publish(
    claim: Claim,
    result: {
      sourceHash: string;
      language: string;
      summary: string;
      recipe: SummaryRecipe | null;
    },
  ): Promise<string | null | undefined> {
    const body = formatSummaryComment(result, MAX_COMMENT_BODY_LENGTH);
    // Like every member comment, the AI's is moderated: its source is member
    // text that may try to steer the model.
    try {
      await this.moderation.requireAllowed([{ kind: 'text', text: body }]);
    } catch (error) {
      if (!(error instanceof UnprocessableContentException)) throw error;
      this.logger.warn(
        `Post ${claim.postId} skipped: moderation rejected its summary comment`,
      );
      await this.finish(claim, {
        status: PostSummaryStatus.SKIPPED,
        sourceHash: result.sourceHash,
        model: this.generator.modelId,
        error: 'CONTENT_REJECTED',
      });
      return undefined;
    }
    return this.mongo.withTransaction(async (session) => {
      // Like a member's comment, this write conflicts with deleting the post.
      const post = await this.posts
        .findOneAndUpdate(
          { _id: claim.postId, status: PostStatus.PUBLISHED },
          { $inc: { commentRevision: 1 } },
          { returnDocument: 'after', session, timestamps: false },
        )
        .exec();
      let commentId: string | null = null;
      if (post) {
        const [comment] = await this.comments.create(
          [{ postId: claim.postId, authorId: SYSTEM_ACCOUNT_ID, body }],
          { session },
        );
        commentId = comment.id;
      }
      const stored = await this.summaries
        .updateOne(
          { _id: claim.id, claimedAt: claim.claimedAt },
          {
            $set: {
              status: PostSummaryStatus.READY,
              sourceHash: result.sourceHash,
              language: result.language,
              summary: result.summary,
              recipe: result.recipe,
              model: this.generator.modelId,
              commentId,
              error: null,
            },
          },
          { session },
        )
        .exec();
      if (stored.matchedCount === 0) throw new ClaimLostError();
      return commentId;
    });
  }

  private async finish(
    claim: Claim,
    change: Partial<
      Pick<PostSummary, 'status' | 'sourceHash' | 'model' | 'error'>
    >,
  ): Promise<void> {
    await this.summaries.updateOne(
      { _id: claim.id, claimedAt: claim.claimedAt },
      { $set: { error: null, ...change } },
    );
  }

  /** The text to summarize, and a one-line description of it for the log. */
  private sourceOf(post: Post): Promise<PostSource> {
    return readPostSource(post, this.mediaAssets);
  }
}

function describeRecipe(recipe: SummaryRecipe | null): string {
  if (!recipe) return 'no recipe';
  return `recipe "${recipe.title}" (${recipe.ingredients.length} ingredients, ${recipe.steps.length} steps)`;
}

function textLength(parts: SummarySourcePart[]): number {
  let length = 0;
  for (const part of parts) length += part.text.trim().length;
  return length;
}

function hashParts(parts: SummarySourcePart[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function normalizeLanguage(language: string): string {
  const code = language.trim().toLowerCase().slice(0, 2);
  if (/^[a-z]{2}$/.test(code)) return code;
  return 'vi';
}

function positiveOrNull(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function trimmedOrNull(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed;
}

/** Drops empty lines and impossible numbers the model may return. */
function cleanRecipe(recipe: SummaryOutput['recipe']): SummaryRecipe | null {
  if (!recipe) return null;
  const title = recipe.title.trim();
  if (!title) return null;
  const ingredients: SummaryRecipe['ingredients'] = [];
  for (const ingredient of recipe.ingredients) {
    const name = ingredient.name.trim();
    if (!name) continue;
    ingredients.push({
      name,
      quantity: positiveOrNull(ingredient.quantity),
      unit: trimmedOrNull(ingredient.unit),
      note: trimmedOrNull(ingredient.note),
    });
  }
  const steps: string[] = [];
  for (const step of recipe.steps) {
    const text = step.trim();
    if (text) steps.push(text);
  }
  if (ingredients.length === 0 && steps.length === 0) return null;
  return {
    title,
    description: trimmedOrNull(recipe.description),
    tag: recipe.tag,
    servings: positiveOrNull(recipe.servings),
    prepMinutes: positiveOrNull(recipe.prepMinutes),
    cookMinutes: positiveOrNull(recipe.cookMinutes),
    ingredients,
    steps,
  };
}
