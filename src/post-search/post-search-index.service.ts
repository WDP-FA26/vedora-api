import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Model } from 'mongoose';
import { MediaAsset, Post, PostStatus, PostType } from '../mongo/models';
import { QdrantService } from '../qdrant/qdrant.service';
import { PostEmbeddingsService } from './post-embeddings.service';
import {
  BM25_FOLDED_VECTOR,
  BM25_VECTOR,
  bm25,
  DENSE_VECTOR,
  type PostPointPayload,
  toEpochSeconds,
} from './post-search-collection';

const BATCH_SIZE = 64;
/**
 * Characters per embedded chunk, well inside the embedding model's input
 * limit. Every chunk of a post is embedded, so none of its text is dropped.
 */
const CHUNK_LENGTH = 1500;

/**
 * The posts search covers: published short posts. One with neither text nor
 * speech is marked indexed without a point; captioning marks it again.
 */
export const SEARCHABLE_POST = {
  type: PostType.POST,
  status: PostStatus.PUBLISHED,
} as const;

/**
 * Keeps the Qdrant post collection in step with MongoDB. A post is indexed
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
    private readonly qdrant: QdrantService,
    private readonly embeddings: PostEmbeddingsService,
    configService: ConfigService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(MediaAsset.name) private readonly media: Model<MediaAsset>,
  ) {
    this.collection = configService.get<string>(
      'QDRANT_POSTS_COLLECTION',
      // v2 adds `publishedAt` to the payload for the feed.
      'vedora_posts_v2',
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

  /** Catches up on posts published by Cloudinary notifications or during an outage. */
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
    const rows = await this.posts
      .find({ ...SEARCHABLE_POST, searchIndexedAt: null })
      .sort({ publishedAt: 1, _id: 1 })
      .limit(BATCH_SIZE)
      .exec();
    if (rows.length === 0) return 0;
    const media = await this.media
      .find({
        postId: { $in: rows.map(({ id }) => id) },
        transcript: { $ne: null },
      })
      .sort({ position: 1 })
      .select('postId transcript')
      .exec();
    const posts = rows.map((post) => ({
      post,
      media: media.filter(({ postId }) => postId === post.id),
    }));

    const texts = posts
      .map(({ post, media: attached }) => {
        const text = postText({ body: post.body, media: attached });
        return { post, text, chunks: chunkText(text) };
      })
      .filter(({ chunks }) => chunks.length > 0);
    if (texts.length > 0) {
      // One request for every chunk of the batch, then one vector per post.
      const chunkVectors = await this.embeddings.embedPosts(
        texts.flatMap(({ chunks }) => chunks),
      );
      let next = 0;
      const vectors = texts.map(({ chunks }) =>
        meanVector(chunkVectors.slice(next, (next += chunks.length))),
      );
      await this.qdrant.upsert(this.collection, {
        wait: true,
        points: texts.map(
          ({ post, text }, index) =>
            ({
              id: post.id,
              vector: {
                [DENSE_VECTOR]: vectors[index],
                [BM25_VECTOR]: bm25(text, false),
                [BM25_FOLDED_VECTOR]: bm25(text, true),
              },
              payload: {
                postId: post.id,
                authorId: post.authorId,
                publishedAt: toEpochSeconds(post.publishedAt ?? new Date()),
              } satisfies PostPointPayload,
            }) as const,
        ),
      });
    }
    // Only posts unchanged since they were read: one whose captioning
    // finished meanwhile was marked for indexing again, with its transcript.
    const indexedAt = new Date();
    // A post edited since it was read keeps waiting for the next batch.
    for (const { post } of posts) {
      await this.posts
        .updateOne(
          { _id: post.id, updatedAt: post.updatedAt },
          { $set: { searchIndexedAt: indexedAt } },
        )
        .exec();
    }
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
    await this.qdrant.createPayloadIndex(this.collection, {
      field_name: 'publishedAt',
      field_schema: { type: 'integer', lookup: false, range: true },
      wait: true,
    });
    // A new (or recreated) collection is empty: index every post again.
    const { modifiedCount } = await this.posts
      .updateMany(
        { searchIndexedAt: { $ne: null } },
        { $set: { searchIndexedAt: null } },
      )
      .exec();
    this.logger.log(
      `Created Qdrant collection ${this.collection}; reindexing ${modifiedCount} posts`,
    );
  }
}

/** A post's body, then the transcripts of its videos, in full. */
function postText(post: {
  body: string | null;
  media: { transcript: string | null }[];
}): string {
  return [post.body, ...post.media.map(({ transcript }) => transcript)]
    .filter((part): part is string => !!part?.trim())
    .join('\n');
}

/**
 * `text` in pieces of at most `size` characters, cut at the last space or
 * line break before the limit (mid-word only when a piece has none).
 */
export function chunkText(text: string, size = CHUNK_LENGTH): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    const space = Math.max(
      rest.lastIndexOf(' ', size),
      rest.lastIndexOf('\n', size),
    );
    const end = space > size / 2 ? space : size;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** The normalized mean of `vectors`: one point stands for a post's chunks. */
export function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 1) return vectors[0];
  const sum = vectors[0].map((_, i) =>
    vectors.reduce((total, vector) => total + vector[i], 0),
  );
  const norm = Math.hypot(...sum) || 1;
  return sum.map((value) => value / norm);
}
