import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { type Post, PostStatus, type Stored } from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';

const FLUSH_INTERVAL_MS = 10_000;
/** The same viewer seeing a post again within this window is one view. */
const DEDUPE_WINDOW_MS = 30 * 60_000;
/** Oldest entries are dropped past this, so memory stays bounded under load. */
const MAX_DEDUPE_ENTRIES = 200_000;
/** Posts updated per command, to keep each one short. */
const FLUSH_BATCH_SIZE = 500;

/**
 * Counts post views without a database write per view: views are deduplicated
 * and summed in memory, then added to `posts.viewCount` in one command
 * every few seconds (write-behind). The count is eventually consistent and
 * approximate by design: a crash loses the unflushed seconds, and with several
 * API instances each dedupes on its own (their increments still add up).
 * Moving `pending` and `seen` to Redis (INCRBY, SET NX EX) would share them.
 */
@Injectable()
export class PostViewsService implements OnApplicationShutdown {
  private readonly logger = new Logger(PostViewsService.name);
  private pending = new Map<string, number>();
  /** `viewer:post` to when it stops suppressing repeat views; insertion-ordered. */
  private readonly seen = new Map<string, number>();

  constructor(private readonly mongo: MongoService) {}

  /** `viewer` is the user id, or the IP address of a guest. */
  record(viewer: string, postIds: string[], now = Date.now()): void {
    for (const postId of new Set(postIds)) {
      const key = `${viewer}:${postId}`;
      const expiresAt = this.seen.get(key);
      if (expiresAt !== undefined && expiresAt > now) continue;

      // Re-inserted so the map stays ordered by expiry.
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
        // A driver bulk write: one round trip for the batch, and `updatedAt` stays
        // put. Ids of deleted or unpublished posts simply match nothing.
        await this.mongo.db.collection<Stored<Post>>('posts').bulkWrite(
          rows.map(([id, views]) => ({
            updateOne: {
              filter: { _id: id, status: PostStatus.PUBLISHED },
              update: { $inc: { viewCount: views } },
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
