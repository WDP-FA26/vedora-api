import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  Post,
  PostBookmark,
  PostComment,
  PostLike,
  PostStatus,
} from '../../mongo/models.js';
import { QdrantService } from '../../qdrant/qdrant.service.js';
import { DENSE_VECTOR, toEpochSeconds } from './post-search-collection.js';
import { PostSearchIndexService } from './post-search-index.service.js';

export const MAX_FEED_RESULTS = 200;
const TASTE_POSTS = 20;
const WINDOW_SECONDS = 7 * 24 * 60 * 60;
const HALF_LIFE_SECONDS = 2 * 24 * 60 * 60;
const FRESHNESS_WEIGHT = 0.05;
const EXPLORE_EVERY = 5;

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

  private async tastePosts(viewerId: string, asOf: Date): Promise<string[]> {
    const until = { createdAt: { $lte: asOf } };
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
    const interactedPostIds = new Set<string>();
    for (const { postId } of interactions) interactedPostIds.add(postId);
    const published = await this.posts
      .find({
        _id: { $in: Array.from(interactedPostIds) },
        status: PostStatus.PUBLISHED,
      })
      .select('_id')
      .exec();
    const live = new Set(published.map(({ id }) => id));
    const newestFirst = interactions
      .filter(({ postId }) => live.has(postId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const recentPostIds = new Set<string>();
    for (const { postId } of newestFirst) {
      recentPostIds.add(postId);
      if (recentPostIds.size === TASTE_POSTS) break;
    }
    return Array.from(recentPostIds);
  }

  private async similar(
    likedIds: string[],
    viewerId: string,
    asOf: Date,
    count: number,
  ): Promise<string[]> {
    if (likedIds.length === 0) return [];
    await this.index.ensureCollection();
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
