import { runtimeConfig } from '../../config/runtime-config.js';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import type { Model } from 'mongoose';
import { AccountStatus, User } from '../../mongo/models.js';
import { QdrantService } from '../../qdrant/qdrant.service.js';
import {
  BIO_BM25_FOLDED_VECTOR,
  BIO_BM25_VECTOR,
  buildProfileIdentityText,
  IDENTITY_BM25_FOLDED_VECTOR,
  IDENTITY_BM25_VECTOR,
  IDENTITY_PREFIX_VECTOR,
  PROFILE_SEARCH_SPARSE_VECTORS,
  profileBm25,
  profilePrefixBm25,
} from './profile-search-collection.js';

const BATCH_SIZE = 64;

export const SEARCHABLE_PROFILE = {
  status: AccountStatus.ACTIVE,
  emailVerifiedAt: { $ne: null },
} as const;

@Injectable()
export class ProfileSearchIndexService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProfileSearchIndexService.name);
  readonly collection: string;
  private collectionReady: Promise<void> | null = null;
  private draining: Promise<void> | null = null;
  private drainAgain = false;

  constructor(
    private readonly qdrant: QdrantService,
    configService: ConfigService,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {
    this.collection = configService.get<string>(
      'QDRANT_PROFILES_COLLECTION',
      'vedora_profiles_v1',
    );
  }

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.schedule();
  }

  schedule(): void {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = this.drain()
      .catch((error: unknown) => {
        this.logger.warn(`Profile indexing failed: ${String(error)}`);
      })
      .finally(() => {
        this.draining = null;
        if (this.drainAgain) {
          this.drainAgain = false;
          this.schedule();
        }
      });
  }

  @Cron(runtimeConfig.POST_SEARCH_INDEX_CRON)
  catchUp(): void {
    this.schedule();
  }

  async drain(): Promise<void> {
    let indexed: number;
    do {
      indexed = await this.indexBatch();
    } while (indexed === BATCH_SIZE);
  }

  async remove(userId: string): Promise<void> {
    try {
      await this.qdrant.delete(this.collection, {
        wait: true,
        points: [userId],
      });
    } catch (error) {
      this.logger.warn(
        `Could not remove profile ${userId} from search: ${String(error)}`,
      );
    }
  }

  async removeMany(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.qdrant.delete(this.collection, { wait: true, points: userIds });
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
    const rows = await this.users
      .find({ ...SEARCHABLE_PROFILE, searchIndexedAt: null })
      .sort({ createdAt: 1, _id: 1 })
      .limit(BATCH_SIZE)
      .select('fullName username bio updatedAt')
      .exec();
    if (rows.length === 0) return 0;

    await this.qdrant.upsert(this.collection, {
      wait: true,
      points: rows.map((user) => {
        const identity = buildProfileIdentityText({
          fullName: user.fullName,
          username: user.username,
        });
        const bio = user.bio?.trim() ?? '';
        return {
          id: user.id,
          vector: {
            [IDENTITY_BM25_VECTOR]: profileBm25(identity, false),
            [IDENTITY_BM25_FOLDED_VECTOR]: profileBm25(identity, true),
            [IDENTITY_PREFIX_VECTOR]: profilePrefixBm25(identity),
            ...(bio
              ? {
                  [BIO_BM25_VECTOR]: profileBm25(bio, false),
                  [BIO_BM25_FOLDED_VECTOR]: profileBm25(bio, true),
                }
              : {}),
          },
          payload: { userId: user.id },
        } as const;
      }),
    });

    const indexedAt = new Date();
    for (const user of rows) {
      await this.users
        .updateOne(
          { _id: user.id, updatedAt: user.updatedAt },
          { $set: { searchIndexedAt: indexedAt } },
        )
        .exec();
    }
    return rows.length;
  }

  private async createCollection(): Promise<void> {
    if ((await this.qdrant.collectionExists(this.collection)).exists) {
      const { config } = await this.qdrant.getCollection(this.collection);
      const sparse = config.params.sparse_vectors ?? {};
      const missing = PROFILE_SEARCH_SPARSE_VECTORS.some(
        (name) => !(name in sparse),
      );
      if (missing) {
        throw new Error(
          `Qdrant collection ${this.collection} does not hold profile BM25 vectors; use a new QDRANT_PROFILES_COLLECTION`,
        );
      }
      return;
    }

    await this.qdrant.createCollection(this.collection, {
      sparse_vectors: {
        [IDENTITY_BM25_VECTOR]: { modifier: 'idf' },
        [IDENTITY_BM25_FOLDED_VECTOR]: { modifier: 'idf' },
        [IDENTITY_PREFIX_VECTOR]: { modifier: 'idf' },
        [BIO_BM25_VECTOR]: { modifier: 'idf' },
        [BIO_BM25_FOLDED_VECTOR]: { modifier: 'idf' },
      },
    });

    const { modifiedCount } = await this.users
      .updateMany(
        { searchIndexedAt: { $ne: null } },
        { $set: { searchIndexedAt: null } },
      )
      .exec();
    this.logger.log(
      `Created Qdrant collection ${this.collection}; reindexing ${modifiedCount} profiles`,
    );
  }
}
