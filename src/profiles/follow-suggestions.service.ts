import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FollowSuggestionReason, PostStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  FollowSuggestionDto,
  FollowSuggestionListDto,
} from './dto/follow-suggestion.dto';

/** Newest followings of a user, and newest followings of each of those. */
const FAN_OUT = 200;
const KEPT_PER_USER = 30;
/** Rows of `users` rebuilt per SQL statement. */
const BATCH_SIZE = 200;
/** A follow-back outranks any realistic mutual count. */
const FOLLOWS_YOU_SCORE = 1000;
const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVE_POOL_SIZE = 50;
const ACTIVE_CACHE_MS = 10 * 60 * 1000;

const candidateSelect = {
  id: true,
  username: true,
  fullName: true,
  bio: true,
  avatarUrl: true,
  coverUrl: true,
  isProfessional: true,
} satisfies Prisma.UserSelect;
type Candidate = Prisma.UserGetPayload<{ select: typeof candidateSelect }>;

interface SuggestionRow {
  user_id: string;
  candidate_id: string;
  mutual_count: number;
  follows_you: boolean;
}

/**
 * "Who to follow": friends-of-friends and follow-backs, rebuilt hourly into
 * `follow_suggestions`, with recently active authors filling the gaps.
 */
@Injectable()
export class FollowSuggestionsService {
  private readonly logger = new Logger(FollowSuggestionsService.name);
  private activeAuthors: { ids: string[]; expiresAt: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, limit: number): Promise<FollowSuggestionListDto> {
    const dismissed = (
      await this.prisma.suggestionDismissal.findMany({
        where: { userId },
        select: { candidateId: true },
      })
    ).map((row) => row.candidateId);

    const stored = await this.prisma.followSuggestion.findMany({
      where: {
        userId,
        candidateId: { notIn: dismissed },
        candidate: {
          emailVerifiedAt: { not: null },
          followers: { none: { followerId: userId } },
        },
      },
      orderBy: [{ score: 'desc' }, { candidateId: 'asc' }],
      take: limit,
      select: {
        reason: true,
        mutualCount: true,
        candidate: { select: candidateSelect },
      },
    });
    const items: FollowSuggestionDto[] = stored.map((row) => ({
      ...this.summary(row.candidate),
      reason: row.reason,
      mutualCount: row.mutualCount,
    }));

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
    await this.prisma.$transaction([
      this.prisma.suggestionDismissal.createMany({
        data: [{ userId, candidateId }],
        skipDuplicates: true,
      }),
      this.prisma.followSuggestion.deleteMany({
        where: { userId, candidateId },
      }),
    ]);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async rebuildAll(): Promise<void> {
    let after: string | undefined;
    let users = 0;
    for (;;) {
      const batch = await this.prisma.user.findMany({
        where: { emailVerifiedAt: { not: null } },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(after && { cursor: { id: after }, skip: 1 }),
        select: { id: true },
      });
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
    const rows = await this.prisma.$queryRaw<SuggestionRow[]>`
      WITH mine AS (
        SELECT user_id, via_id FROM (
          SELECT follower_id AS user_id, following_id AS via_id,
                 row_number() OVER (
                   PARTITION BY follower_id ORDER BY created_at DESC, following_id
                 ) AS rn
          FROM follows
          WHERE follower_id = ANY(${userIds}::uuid[])
        ) ranked
        WHERE rn <= ${FAN_OUT}
      ),
      signals AS (
        SELECT m.user_id, fof.following_id AS candidate_id,
               1 AS mutual_count, false AS follows_you
        FROM mine m
        CROSS JOIN LATERAL (
          SELECT following_id FROM follows
          WHERE follower_id = m.via_id
          ORDER BY created_at DESC
          LIMIT ${FAN_OUT}
        ) fof
        UNION ALL
        SELECT following_id, follower_id, 0, true
        FROM follows
        WHERE following_id = ANY(${userIds}::uuid[])
      ),
      combined AS (
        SELECT user_id, candidate_id,
               sum(mutual_count)::int AS mutual_count,
               bool_or(follows_you) AS follows_you
        FROM signals
        GROUP BY user_id, candidate_id
      ),
      ranked AS (
        SELECT c.*,
               row_number() OVER (
                 PARTITION BY c.user_id
                 ORDER BY c.follows_you DESC, c.mutual_count DESC, c.candidate_id
               ) AS rn
        FROM combined c
        JOIN users u ON u.id = c.candidate_id AND u.email_verified_at IS NOT NULL
        WHERE c.candidate_id <> c.user_id
          AND NOT EXISTS (
            SELECT 1 FROM follows f
            WHERE f.follower_id = c.user_id AND f.following_id = c.candidate_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM suggestion_dismissals d
            WHERE d.user_id = c.user_id AND d.candidate_id = c.candidate_id
          )
      )
      SELECT user_id, candidate_id, mutual_count, follows_you
      FROM ranked
      WHERE rn <= ${KEPT_PER_USER}
    `;

    await this.prisma.$transaction([
      this.prisma.followSuggestion.deleteMany({
        where: { userId: { in: userIds } },
      }),
      this.prisma.followSuggestion.createMany({
        data: rows.map((row) => ({
          userId: row.user_id,
          candidateId: row.candidate_id,
          mutualCount: row.mutual_count,
          reason: row.follows_you
            ? FollowSuggestionReason.FOLLOWS_YOU
            : FollowSuggestionReason.MUTUAL,
          score: row.mutual_count + (row.follows_you ? FOLLOWS_YOU_SCORE : 0),
        })),
      }),
    ]);
  }

  /** Authors with the most recent published posts, shared by every user. */
  private async activePool(): Promise<string[]> {
    if (this.activeAuthors && this.activeAuthors.expiresAt > Date.now()) {
      return this.activeAuthors.ids;
    }
    const groups = await this.prisma.post.groupBy({
      by: ['authorId'],
      where: {
        status: PostStatus.PUBLISHED,
        publishedAt: { gte: new Date(Date.now() - ACTIVE_WINDOW_MS) },
        author: { emailVerifiedAt: { not: null } },
      },
      _count: { _all: true },
      orderBy: [{ _count: { authorId: 'desc' } }, { authorId: 'asc' }],
      take: ACTIVE_POOL_SIZE,
    });
    const ids = groups.map((group) => group.authorId);
    this.activeAuthors = { ids, expiresAt: Date.now() + ACTIVE_CACHE_MS };
    return ids;
  }

  private async activeCandidates(
    userId: string,
    taken: Set<string>,
    count: number,
  ): Promise<Candidate[]> {
    const pool = (await this.activePool()).filter((id) => !taken.has(id));
    if (pool.length === 0) return [];
    const followed = new Set(
      (
        await this.prisma.follow.findMany({
          where: { followerId: userId, followingId: { in: pool } },
          select: { followingId: true },
        })
      ).map((row) => row.followingId),
    );
    const ids = pool.filter((id) => !followed.has(id)).slice(0, count);
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: candidateSelect,
    });
    // `findMany` ignores the order of `ids`.
    return ids.flatMap((id) => users.find((user) => user.id === id) ?? []);
  }

  private summary(user: Candidate) {
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
