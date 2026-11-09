import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '@nestjs/ai';
import { InjectModel } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Model } from 'mongoose';
import { MediaAsset, Post, PostStatus, PostType } from '../../mongo/models.js';
import { QdrantService } from '../../qdrant/qdrant.service.js';
import {
  BM25_FOLDED_VECTOR,
  BM25_VECTOR,
  bm25,
  DENSE_VECTOR,
  type PostPointPayload,
  toEpochSeconds,
} from './post-search-collection.js';

const BATCH_SIZE = 64;
const CHUNK_LENGTH = 1500;

export const SEARCHABLE_POST = {
  type: PostType.POST,
  status: PostStatus.PUBLISHED,
} as const;

@Injectable()
export class PostSearchIndexService {
  private readonly logger = new Logger(PostSearchIndexService.name);
  readonly collection: string;
  readonly dimensions: number;
  private collectionReady: Promise<void> | null = null;
  private draining: Promise<void> | null = null;
  private drainAgain = false;

  constructor(
    private readonly qdrant: QdrantService,
    private readonly ai: AiService,
    configService: ConfigService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(MediaAsset.name) private readonly media: Model<MediaAsset>,
  ) {
    this.collection = configService.get<string>(
      'QDRANT_POSTS_COLLECTION',
      'vedora_posts_v2',
    );
    this.dimensions = configService.get<number>(
      'POST_SEARCH_EMBEDDING_DIMENSIONS',
      768,
    );
  }

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

  @Cron(CronExpression.EVERY_MINUTE)
  catchUp(): void {
    this.schedule();
  }

  async drain(): Promise<void> {
    let indexed: number;
    do {
      indexed = await this.indexBatch();
    } while (indexed === BATCH_SIZE);
  }

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
      const { embeddings: chunkVectors } = await this.ai.embedMany({
        model: 'posts',
        label: 'index-posts',
        values: texts.flatMap(({ chunks }) =>
          chunks.map((chunk) => `title: none | text: ${chunk}`),
        ),
      });
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
    const indexedAt = new Date();
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
    const size = this.dimensions;
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

function postText(post: {
  body: string | null;
  media: { transcript: string | null }[];
}): string {
  return [post.body, ...post.media.map(({ transcript }) => transcript)]
    .filter((part): part is string => !!part?.trim())
    .join('\n');
}

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

export function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 1) return vectors[0];
  const sum = vectors[0].map((_, i) =>
    vectors.reduce((total, vector) => total + vector[i], 0),
  );
  const norm = Math.hypot(...sum) || 1;
  return sum.map((value) => value / norm);
}
