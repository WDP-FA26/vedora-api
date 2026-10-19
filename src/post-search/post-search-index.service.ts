import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PostStatus, PostType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QdrantService } from '../qdrant/qdrant.service';
import { PostEmbeddingsService } from './post-embeddings.service';
import {
  BM25_FOLDED_VECTOR,
  BM25_VECTOR,
  bm25,
  DENSE_VECTOR,
  type PostPointPayload,
} from './post-search-collection';

const BATCH_SIZE = 64;

/** The posts search covers: published short posts with text. */
export const SEARCHABLE_POST = {
  type: PostType.POST,
  status: PostStatus.PUBLISHED,
  body: { not: null },
} satisfies Prisma.PostWhereInput;

/**
 * Keeps the Qdrant post collection in step with Postgres. A post is indexed
 * once it is published; `searchIndexedAt` records that, so posts published
 * while OpenRouter or Qdrant was down are caught up by the cron.
 */
@Injectable()
export class PostSearchIndexService {
  private readonly logger = new Logger(PostSearchIndexService.name);
  readonly collection: string;
  private collectionReady: Promise<void> | null = null;
  private draining: Promise<void> | null = null;
  private drainAgain = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly qdrant: QdrantService,
    private readonly embeddings: PostEmbeddingsService,
    configService: ConfigService,
  ) {
    this.collection = configService.get<string>(
      'QDRANT_POSTS_COLLECTION',
      'vedora_posts',
    );
  }

  /** Indexes pending posts in the background; never throws. */
  schedule(): void {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = this.drain()
      .catch((error: unknown) => {
        this.logger.warn(`Post indexing failed: ${String(error)}`);
      })
      .finally(() => {
        this.draining = null;
        if (this.drainAgain) {
          this.drainAgain = false;
          this.schedule();
        }
      });
  }

  /** Catches up on posts published by Mux webhooks or during an outage. */
  @Cron(CronExpression.EVERY_MINUTE)
  catchUp(): void {
    this.schedule();
  }

  /** Indexes every pending post, a batch at a time. */
  async drain(): Promise<void> {
    let indexed: number;
    do {
      indexed = await this.indexBatch();
    } while (indexed === BATCH_SIZE);
  }

  /** Removes a deleted post; a leftover point is pruned when search finds it. */
  async remove(postId: string): Promise<void> {
    try {
      await this.qdrant.delete(this.collection, {
        wait: true,
        points: [postId],
      });
    } catch (error) {
      this.logger.warn(
        `Could not remove post ${postId} from search: ${String(error)}`,
      );
    }
  }

  async removeMany(postIds: string[]): Promise<void> {
    if (postIds.length === 0) return;
    await this.qdrant.delete(this.collection, { wait: true, points: postIds });
  }

  ensureCollection(): Promise<void> {
    this.collectionReady ??= this.createCollection().catch((error: unknown) => {
      this.collectionReady = null;
      throw error;
    });
    return this.collectionReady;
  }

  private async indexBatch(): Promise<number> {
    await this.ensureCollection();
    const posts = await this.prisma.post.findMany({
      where: { ...SEARCHABLE_POST, searchIndexedAt: null },
      orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
      take: BATCH_SIZE,
      select: { id: true, authorId: true, body: true },
    });
    if (posts.length === 0) return 0;

    const bodies = posts.map(({ body }) => body ?? '');
    const vectors = await this.embeddings.embedPosts(bodies);
    await this.qdrant.upsert(this.collection, {
      wait: true,
      points: posts.map(({ id, authorId }, index) => ({
        id,
        vector: {
          [DENSE_VECTOR]: vectors[index],
          [BM25_VECTOR]: bm25(bodies[index], false),
          [BM25_FOLDED_VECTOR]: bm25(bodies[index], true),
        },
        payload: { postId: id, authorId } satisfies PostPointPayload,
      })),
    });
    await this.prisma.post.updateMany({
      where: { id: { in: posts.map(({ id }) => id) } },
      data: { searchIndexedAt: new Date() },
    });
    return posts.length;
  }

  private async createCollection(): Promise<void> {
    const size = this.embeddings.dimensions;
    if ((await this.qdrant.collectionExists(this.collection)).exists) {
      const { config } = await this.qdrant.getCollection(this.collection);
      const vectors = config.params.vectors;
      const dense =
        vectors && !('size' in vectors) ? vectors[DENSE_VECTOR] : undefined;
      if (dense?.size !== size) {
        throw new Error(
          `Qdrant collection ${this.collection} does not hold ${size}-dimension "${DENSE_VECTOR}" vectors; use a new QDRANT_POSTS_COLLECTION`,
        );
      }
      return;
    }
    await this.qdrant.createCollection(this.collection, {
      vectors: { [DENSE_VECTOR]: { size, distance: 'Cosine', on_disk: true } },
      sparse_vectors: {
        [BM25_VECTOR]: { modifier: 'idf' },
        [BM25_FOLDED_VECTOR]: { modifier: 'idf' },
      },
      quantization_config: { scalar: { type: 'int8', always_ram: true } },
    });
    await this.qdrant.createPayloadIndex(this.collection, {
      field_name: 'authorId',
      field_schema: 'keyword',
      wait: true,
    });
    // A new (or recreated) collection is empty: index every post again.
    const { count } = await this.prisma.post.updateMany({
      where: { searchIndexedAt: { not: null } },
      data: { searchIndexedAt: null },
    });
    this.logger.log(
      `Created Qdrant collection ${this.collection}; reindexing ${count} posts`,
    );
  }
}
