import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import type { Model } from 'mongoose';
import { Post, PostStatus } from '../mongo/models.js';

const FLUSH_INTERVAL_MS = 10_000;
const DEDUPE_WINDOW_MS = 30 * 60_000;
const MAX_DEDUPE_ENTRIES = 200_000;
const FLUSH_BATCH_SIZE = 500;

@Injectable()
export class PostViewsService implements OnApplicationShutdown {
  private readonly logger = new Logger(PostViewsService.name);
  private pending = new Map<string, number>();
  private readonly seen = new Map<string, number>();

  constructor(@InjectModel(Post.name) private readonly posts: Model<Post>) {}

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
  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = [...this.pending];
    this.pending = new Map();

    for (let start = 0; start < batch.length; start += FLUSH_BATCH_SIZE) {
      const rows = batch.slice(start, start + FLUSH_BATCH_SIZE);
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
      } catch (error) {
        this.logger.warn(
          `Saving views of ${rows.length} posts failed: ${String(error)}; retrying`,
        );
        for (const [id, views] of rows) {
          this.pending.set(id, (this.pending.get(id) ?? 0) + views);
        }
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.flush();
  }

  private evict(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt > now && this.seen.size <= MAX_DEDUPE_ENTRIES) break;
      this.seen.delete(key);
    }
  }
}
