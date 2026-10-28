import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { isUniqueViolation } from '../mongo/errors.js';
import {
  Follow,
  FollowSuggestion,
  FollowSuggestionReason,
  Post,
  PostStatus,
  SuggestionDismissal,
  User,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import {
  FollowSuggestionDto,
  FollowSuggestionListDto,
} from './dto/follow-suggestion.dto.js';

/** Newest followings of a user, and newest followings of each of those. */
const FAN_OUT = 200;
const KEPT_PER_USER = 30;
/** Users rebuilt per round of queries. */
const BATCH_SIZE = 200;
/** A follow-back outranks any realistic mutual count. */
const FOLLOWS_YOU_SCORE = 1000;
const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVE_POOL_SIZE = 50;
const ACTIVE_CACHE_MS = 10 * 60 * 1000;

interface SuggestionRow {
  userId: string;
  candidateId: string;
  mutualCount: number;
  followsYou: boolean;
}

/**
 * "Who to follow": friends-of-friends and follow-backs, rebuilt hourly into
 * `follow_suggestions`, with recently active authors filling the gaps.
 */
@Injectable()
export class FollowSuggestionsService {
  private readonly logger = new Logger(FollowSuggestionsService.name);
  private activeAuthors: { ids: string[]; expiresAt: number } | null = null;

  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Follow.name) private readonly follows: Model<Follow>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(FollowSuggestion.name)
    private readonly suggestions: Model<FollowSuggestion>,
    @InjectModel(SuggestionDismissal.name)
    private readonly dismissals: Model<SuggestionDismissal>,
    private readonly mongo: MongoService,
  ) {}

  async list(userId: string, limit: number): Promise<FollowSuggestionListDto> {
    const dismissed = (
      await this.dismissals.find({ userId }).select('candidateId').exec()
    ).map((row) => row.candidateId);

    // At most KEPT_PER_USER rows. MongoDB has no relation filters, so the
    // candidates' state is checked here.
    const suggestions = await this.suggestions
      .find({ userId, candidateId: { $nin: dismissed } })
      .sort({ score: -1, candidateId: 1 })
      .exec();
    const candidateIds = suggestions.map(({ candidateId }) => candidateId);
    const candidates = await this.users
      .find({ _id: { $in: candidateIds } })
      .exec();
    const candidateById = new Map(candidates.map((user) => [user.id, user]));
    const followed = await this.followedAmong(userId, candidateIds);
    const items: FollowSuggestionDto[] = [];
    for (const row of suggestions) {
      const candidate = candidateById.get(row.candidateId);
      if (
        !candidate ||
        candidate.emailVerifiedAt === null ||
        followed.has(candidate.id)
      )
        continue;
      items.push({
        ...this.summary(candidate),
        reason: row.reason,
        mutualCount: row.mutualCount,
      });
      if (items.length === limit) break;
    }

    if (items.length < limit) {
      const taken = new Set([userId, ...dismissed, ...items.map((i) => i.id)]);
      const active = await this.activeCandidates(
        userId,
        taken,
        limit - items.length,
      );
      items.push(
        ...active.map((candidate) => ({
          ...this.summary(candidate),
          reason: 'ACTIVE' as const,
          mutualCount: 0,
        })),
      );
    }
    return { items };
  }

  /** Remembers the choice so the person never comes back as a suggestion. */
  async dismiss(userId: string, candidateId: string): Promise<void> {
    try {
      await this.dismissals.create({ userId, candidateId });
    } catch (error) {
      // Dismissed already.
      if (!isUniqueViolation(error)) throw error;
    }
    await this.suggestions.deleteOne({ userId, candidateId });
  }

  @Cron(CronExpression.EVERY_HOUR)
  async rebuildAll(): Promise<void> {
    let after: string | undefined;
    let users = 0;
    for (;;) {
      const filter: Record<string, unknown> = {
        emailVerifiedAt: { $ne: null },
      };
      if (after) filter._id = { $gt: after };
      const batch = await this.users
        .find(filter)
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .select('_id')
        .exec();
      if (batch.length === 0) break;
      try {
        await this.rebuild(batch.map((user) => user.id));
      } catch (error) {
        this.logger.error(
          `Follow suggestions failed for a batch after ${after ?? 'start'}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
      users += batch.length;
      after = batch[batch.length - 1].id;
    }
    this.logger.log(`Rebuilt follow suggestions for ${users} users`);
  }

  /** Replaces the stored suggestions of `userIds` in one transaction. */
  async rebuild(userIds: string[]): Promise<void> {
    // Per user: people followed by the people they follow (capped fan-out),
    // plus their own followers. Excludes themselves, anyone they already
    // follow, dismissed people and unverified accounts.
    const rows = await this.suggestionRows(userIds);

    await this.mongo.withTransaction(async (session) => {
      await this.suggestions.deleteMany(
        { userId: { $in: userIds } },
        { session },
      );
      // insertMany rejects an empty list.
      if (rows.length === 0) return;
      await this.suggestions.insertMany(
        rows.map((row) => ({
          userId: row.userId,
          candidateId: row.candidateId,
          mutualCount: row.mutualCount,
          reason: row.followsYou
            ? FollowSuggestionReason.FOLLOWS_YOU
            : FollowSuggestionReason.MUTUAL,
          score: row.mutualCount + (row.followsYou ? FOLLOWS_YOU_SCORE : 0),
        })),
        { session },
      );
    });
  }

  /** Ranked candidates for each of `userIds`, best first, `KEPT_PER_USER` each. */
  private async suggestionRows(userIds: string[]): Promise<SuggestionRow[]> {
    // The newest FAN_OUT followings of each user, and who follows them back.
    const [followings, followers] = await Promise.all([
      this.follows
        .find({ followerId: { $in: userIds } })
        .sort({ createdAt: -1, followingId: 1 })
        .select('followerId followingId')
        .exec(),
      this.follows
        .find({ followingId: { $in: userIds } })
        .select('followerId followingId')
        .exec(),
    ]);
    const via = new Map<string, string[]>();
    for (const { followerId, followingId } of followings) {
      const list = via.get(followerId) ?? [];
      if (list.length < FAN_OUT) list.push(followingId);
      via.set(followerId, list);
    }

    // The newest FAN_OUT followings of each person they follow.
    const viaIdSet = new Set<string>();
    for (const ids of via.values()) {
      for (const id of ids) viaIdSet.add(id);
    }
    const viaIds = Array.from(viaIdSet);
    const secondDegree = new Map<string, string[]>();
    for (let start = 0; start < viaIds.length; start += BATCH_SIZE) {
      const chunk = viaIds.slice(start, start + BATCH_SIZE);
      const lists = await Promise.all(
        chunk.map((id) =>
          this.follows
            .find({ followerId: id })
            .sort({ createdAt: -1, followingId: 1 })
            .limit(FAN_OUT)
            .select('followingId')
            .exec(),
        ),
      );
      chunk.forEach((id, index) =>
        secondDegree.set(
          id,
          lists[index].map((row) => row.followingId),
        ),
      );
    }

    type Signal = { mutualCount: number; followsYou: boolean };
    const signals = new Map<string, Map<string, Signal>>();
    const signal = (userId: string, candidateId: string): Signal => {
      const forUser = signals.get(userId) ?? new Map<string, Signal>();
      signals.set(userId, forUser);
      const entry = forUser.get(candidateId) ?? {
        mutualCount: 0,
        followsYou: false,
      };
      forUser.set(candidateId, entry);
      return entry;
    };
    for (const [userId, viaList] of via) {
      for (const viaId of viaList) {
        for (const candidateId of secondDegree.get(viaId) ?? []) {
          signal(userId, candidateId).mutualCount += 1;
        }
      }
    }
    for (const { followerId, followingId } of followers) {
      signal(followingId, followerId).followsYou = true;
    }

    // Drop themselves, unverified accounts, people they already follow and
    // dismissed people.
    const candidateIds = [
      ...new Set([...signals.values()].flatMap((map) => [...map.keys()])),
    ];
    if (candidateIds.length === 0) return [];
    const [verified, followed, dismissed] = await Promise.all([
      this.users
        .find({ _id: { $in: candidateIds }, emailVerifiedAt: { $ne: null } })
        .select('_id')
        .exec(),
      this.follows
        .find({
          followerId: { $in: userIds },
          followingId: { $in: candidateIds },
        })
        .select('followerId followingId')
        .exec(),
      this.dismissals
        .find({
          userId: { $in: userIds },
          candidateId: { $in: candidateIds },
        })
        .select('userId candidateId')
        .exec(),
    ]);
    const verifiedIds = new Set(verified.map((user) => user.id));
    const excluded = new Set([
      ...followed.map((row) => `${row.followerId}:${row.followingId}`),
      ...dismissed.map((row) => `${row.userId}:${row.candidateId}`),
    ]);

    const rows: SuggestionRow[] = [];
    for (const [userId, forUser] of signals) {
      const ranked = [...forUser]
        .filter(
          ([candidateId]) =>
            candidateId !== userId &&
            verifiedIds.has(candidateId) &&
            !excluded.has(`${userId}:${candidateId}`),
        )
        .map(([candidateId, entry]) => ({ userId, candidateId, ...entry }))
        .sort(
          (a, b) =>
            Number(b.followsYou) - Number(a.followsYou) ||
            b.mutualCount - a.mutualCount ||
            (a.candidateId < b.candidateId ? -1 : 1),
        );
      rows.push(...ranked.slice(0, KEPT_PER_USER));
    }
    return rows;
  }

  /** Authors with the most recent published posts, shared by every user. */
  private async activePool(): Promise<string[]> {
    if (this.activeAuthors && this.activeAuthors.expiresAt > Date.now()) {
      return this.activeAuthors.ids;
    }
    const groups = await this.posts
      .aggregate<{ _id: string; posts: number }>([
        {
          $match: {
            status: PostStatus.PUBLISHED,
            publishedAt: { $gte: new Date(Date.now() - ACTIVE_WINDOW_MS) },
          },
        },
        { $group: { _id: '$authorId', posts: { $sum: 1 } } },
        { $sort: { posts: -1, _id: 1 } },
      ])
      .exec();
    // MongoDB has no relation filters: unverified authors drop out here.
    const verified = await this.users
      .find({
        _id: { $in: groups.map((group) => group._id) },
        emailVerifiedAt: { $ne: null },
      })
      .select('_id')
      .exec();
    const verifiedIds = new Set(verified.map(({ id }) => id));
    const ids = groups
      .map((group) => group._id)
      .filter((id) => verifiedIds.has(id))
      .slice(0, ACTIVE_POOL_SIZE);
    this.activeAuthors = { ids, expiresAt: Date.now() + ACTIVE_CACHE_MS };
    return ids;
  }

  private async activeCandidates(
    userId: string,
    taken: Set<string>,
    count: number,
  ): Promise<User[]> {
    const pool = (await this.activePool()).filter((id) => !taken.has(id));
    if (pool.length === 0) return [];
    const followed = await this.followedAmong(userId, pool);
    const ids = pool.filter((id) => !followed.has(id)).slice(0, count);
    const users = await this.users.find({ _id: { $in: ids } }).exec();
    // A filter by ids ignores their order.
    return ids.flatMap((id) => users.find((user) => user.id === id) ?? []);
  }

  /** Which of `ids` the user follows. */
  private async followedAmong(
    userId: string,
    ids: string[],
  ): Promise<Set<string>> {
    const follows = await this.follows
      .find({ followerId: userId, followingId: { $in: ids } })
      .select('followingId')
      .exec();
    return new Set(follows.map(({ followingId }) => followingId));
  }

  private summary(user: User) {
    return {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      coverUrl: user.coverUrl,
      isProfessional: user.isProfessional,
    };
  }
}
