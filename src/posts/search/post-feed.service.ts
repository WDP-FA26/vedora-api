import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  Post,
  PostBookmark,
  PostComment,
  PostLike,
  PostStatus,
} from '../../mongo/models';
import { QdrantService } from '../../qdrant/qdrant.service';
import { DENSE_VECTOR, toEpochSeconds } from './post-search-collection';
import { PostSearchIndexService } from './post-search-index.service';

/** How deep the feed goes; each source fetches at most this many. */
export const MAX_FEED_RESULTS = 200;
/** The recent posts the viewer liked, saved or commented on that set their taste. */
const TASTE_POSTS = 20;
/** Only posts this recent are picked by taste. */
const WINDOW_SECONDS = 7 * 24 * 60 * 60;
/** A post's freshness bonus halves every this many seconds. */
const HALF_LIFE_SECONDS = 2 * 24 * 60 * 60;
/**
 * The freshness bonus at publication, next to a similarity of up to 1. With
 * gemini-embedding-2, short cooking posts on different topics score within
 * about 0.02 of each other, so a larger bonus outranks taste with recency.
 */
const FRESHNESS_WEIGHT = 0.05;
/** Every this-many-th post is the newest one, whatever the viewer's taste. */
const EXPLORE_EVERY = 5;

/**
 * "For you": recent posts closest in meaning to any post the viewer recently
 * liked, saved or commented on, nudged towards newer ones, with every fifth
 * slot given to the newest post so the feed doesn't narrow to one topic. A
 * viewer with no interactions (or with Qdrant down) gets the newest posts.
 */
@Injectable()
export class PostFeedService {
  private readonly logger = new Logger(PostFeedService.name);

  constructor(
    private readonly qdrant: QdrantService,
    private readonly index: PostSearchIndexService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(PostLike.name) private readonly likes: Model<PostLike>,
    @InjectModel(PostBookmark.name)
    private readonly bookmarks: Model<PostBookmark>,
    @InjectModel(PostComment.name)
    private readonly comments: Model<PostComment>,
  ) {}

  /** The first `count` post ids of the viewer's feed as of `asOf`. */
  async feed(viewerId: string, asOf: Date, count: number): Promise<string[]> {
    const [similar, latest] = await Promise.all([
      this.tastePosts(viewerId, asOf).then((liked) =>
        this.similar(liked, viewerId, asOf, count).catch((error: unknown) => {
          this.logger.warn(`Feed similarity failed: ${String(error)}`);
          return [];
        }),
      ),
      this.latest(viewerId, asOf, count),
    ]);
    return interleave(similar, latest, EXPLORE_EVERY).slice(0, count);
  }

  /**
   * Interactions up to `asOf` only, so every page of one scroll ranks
   * against the same taste: a like made mid-scroll neither reorders nor
   * hides the posts of later pages.
   */
  private async tastePosts(viewerId: string, asOf: Date): Promise<string[]> {
    const until = { createdAt: { $lte: asOf } };
    // MongoDB has no relation filters: load each interaction's post and keep
    // the published ones.
    const [likes, bookmarks, comments] = await Promise.all([
      this.likes
        .find({ userId: viewerId, ...until })
        .sort({ createdAt: -1 })
        .limit(TASTE_POSTS)
        .exec(),
      this.bookmarks
        .find({ userId: viewerId, ...until })
        .sort({ createdAt: -1 })
        .limit(TASTE_POSTS)
        .exec(),
      this.comments
        .find({ authorId: viewerId, ...until })
        .sort({ createdAt: -1 })
        .limit(TASTE_POSTS)
        .exec(),
    ]);
    const interactions = [...likes, ...bookmarks, ...comments];
    const published = await this.posts
      .find({
        _id: { $in: [...new Set(interactions.map(({ postId }) => postId))] },
        status: PostStatus.PUBLISHED,
      })
      .select('_id')
      .exec();
    const live = new Set(published.map(({ id }) => id));
    const ids = interactions
      .filter(({ postId }) => live.has(postId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(({ postId }) => postId);
    return [...new Set(ids)].slice(0, TASTE_POSTS);
  }

  /** Recent posts by others, best `best_score` match plus freshness first. */
  private async similar(
    likedIds: string[],
    viewerId: string,
    asOf: Date,
    count: number,
  ): Promise<string[]> {
    if (likedIds.length === 0) return [];
    await this.index.ensureCollection();
    // Posts without text or speech have no point; recommending from a
    // missing id fails, so pass the vectors of those that exist.
    const liked = await this.qdrant.retrieve(this.index.collection, {
      ids: likedIds,
      with_vector: [DENSE_VECTOR],
      with_payload: false,
    });
    const positive = liked.flatMap(({ vector }) => {
      const dense =
        vector && !Array.isArray(vector) ? vector[DENSE_VECTOR] : null;
      return Array.isArray(dense) && typeof dense[0] === 'number'
        ? [dense as number[]]
        : [];
    });
    if (positive.length === 0) return [];

    const now = toEpochSeconds(asOf);
    const { points } = await this.qdrant.query(this.index.collection, {
      prefetch: {
        query: { recommend: { positive, strategy: 'best_score' } },
        using: DENSE_VECTOR,
        filter: {
          must: [
            {
              key: 'publishedAt',
              range: { gte: now - WINDOW_SECONDS, lte: now },
            },
          ],
          must_not: [
            { key: 'authorId', match: { value: viewerId } },
            { has_id: likedIds },
          ],
        },
        limit: MAX_FEED_RESULTS,
      },
      query: {
        formula: {
          sum: [
            '$score',
            {
              mult: [
                FRESHNESS_WEIGHT,
                {
                  exp_decay: {
                    x: 'publishedAt',
                    target: now,
                    scale: HALF_LIFE_SECONDS,
                  },
                },
              ],
            },
          ],
        },
      },
      limit: count,
      with_payload: false,
    });
    return points.map(({ id }) => String(id));
  }

  /** Published posts by others, newest first, up to `asOf`. */
  private async latest(
    viewerId: string,
    asOf: Date,
    count: number,
  ): Promise<string[]> {
    const posts = await this.posts
      .find({
        status: PostStatus.PUBLISHED,
        publishedAt: { $lte: asOf },
        authorId: { $ne: viewerId },
      })
      .sort({ publishedAt: -1, _id: -1 })
      .limit(count)
      .select('_id')
      .exec();
    return posts.map(({ id }) => id);
  }
}

/**
 * `similar` with every `every`-th slot taken from `latest`, without repeats.
 * When one list runs out the other fills the rest.
 */
export function interleave(
  similar: string[],
  latest: string[],
  every: number,
): string[] {
  const merged: string[] = [];
  const taken = new Set<string>();
  let s = 0;
  let l = 0;
  for (;;) {
    while (s < similar.length && taken.has(similar[s])) s++;
    while (l < latest.length && taken.has(latest[l])) l++;
    const exploreSlot = (merged.length + 1) % every === 0;
    let id: string;
    if ((exploreSlot || s === similar.length) && l < latest.length) {
      id = latest[l++];
    } else if (s < similar.length) {
      id = similar[s++];
    } else {
      return merged;
    }
    taken.add(id);
    merged.push(id);
  }
}
