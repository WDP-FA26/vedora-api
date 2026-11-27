import { randomUUID } from 'node:crypto';
import { runtimeConfig } from '../config/runtime-config.js';
import { calendarDay } from '../config/time-zone.js';
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import type { Model } from 'mongoose';
import { Post, PostStatus, PostViewDay } from '../mongo/models.js';

const FLUSH_INTERVAL_MS = runtimeConfig.POST_VIEWS_FLUSH_INTERVAL_MS;
const DEDUPE_WINDOW_MS = runtimeConfig.POST_VIEWS_DEDUPE_WINDOW_SECONDS * 1000;
const MAX_DEDUPE_ENTRIES = runtimeConfig.POST_VIEWS_MAX_DEDUPE_ENTRIES;
const FLUSH_BATCH_SIZE = runtimeConfig.POST_VIEWS_FLUSH_BATCH_SIZE;

type ViewRow = [postId: string, views: number];

@Injectable()
export class PostViewsService implements OnApplicationShutdown {
  private readonly logger = new Logger(PostViewsService.name);
  private pending = new Map<string, number>();
  private readonly seen = new Map<string, number>();

  constructor(
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(PostViewDay.name)
    private readonly viewDays: Model<PostViewDay>,
  ) {}

  record(viewer: string, postIds: string[], now = Date.now()): void {
    for (const postId of new Set(postIds)) {
      const key = `${viewer}:${postId}`;
      const expiresAt = this.seen.get(key);
      if (expiresAt !== undefined && expiresAt > now) continue;

      this.seen.delete(key);
      this.seen.set(key, now + DEDUPE_WINDOW_MS);
      this.pending.set(postId, (this.pending.get(postId) ?? 0) + 1);
    }
    this.evict(now);
  }

  @Interval(FLUSH_INTERVAL_MS)
  async flush(now = new Date()): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = [...this.pending];
    this.pending = new Map();
    const day = calendarDay(now, runtimeConfig.APP_TIMEZONE);

    for (let start = 0; start < batch.length; start += FLUSH_BATCH_SIZE) {
      const rows = batch.slice(start, start + FLUSH_BATCH_SIZE);
      const saved = await this.saveTotals(rows);
      if (saved) await this.saveDays(rows, day);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.flush();
  }

  private async saveTotals(rows: ViewRow[]): Promise<boolean> {
    try {
      await this.posts.bulkWrite(
        rows.map(([id, views]) => ({
          updateOne: {
            filter: { _id: id, status: PostStatus.PUBLISHED },
            update: { $inc: { viewCount: views } },
            timestamps: false,
          },
        })),
        { ordered: false },
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Saving views of ${rows.length} posts failed: ${String(error)}; retrying`,
      );
      for (const [id, views] of rows) {
        this.pending.set(id, (this.pending.get(id) ?? 0) + views);
      }
      return false;
    }
  }

  private async saveDays(rows: ViewRow[], day: string): Promise<void> {
    try {
      const published = await this.posts
        .find({
          _id: { $in: rows.map(([id]) => id) },
          status: PostStatus.PUBLISHED,
        })
        .select('authorId')
        .lean()
        .exec();
      if (published.length === 0) return;

      const authorOf = new Map<string, string>();
      for (const post of published) authorOf.set(post._id, post.authorId);

      const updates = [];
      for (const [postId, views] of rows) {
        const authorId = authorOf.get(postId);
        if (authorId === undefined) continue;
        updates.push({
          updateOne: {
            filter: { postId, date: day },
            update: {
              $inc: { count: views },
              $setOnInsert: { _id: randomUUID(), authorId },
            },
            upsert: true,
          },
        });
      }
      await this.viewDays.bulkWrite(updates, { ordered: false });
    } catch (error) {
      this.logger.warn(
        `Saving daily views of ${rows.length} posts failed: ${String(error)}; dropped from daily analytics`,
      );
    }
  }

  private evict(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt > now && this.seen.size <= MAX_DEDUPE_ENTRIES) break;
      this.seen.delete(key);
    }
  }
}
