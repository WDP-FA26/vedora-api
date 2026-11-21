import { runtimeConfig } from '../../config/runtime-config.js';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '@nestjs/ai';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import type { Model } from 'mongoose';
import {
  AccountStatus,
  RestaurantMenuItem,
  User,
  VerificationStatus,
  Workspace,
} from '../../mongo/models.js';
import { QdrantService } from '../../qdrant/qdrant.service.js';
import {
  buildMenuItemSearchText,
  MENU_BM25_FOLDED_VECTOR,
  MENU_BM25_VECTOR,
  MENU_DENSE_VECTOR,
  menuBm25,
  type MenuItemPointPayload,
} from './menu-search-collection.js';

const BATCH_SIZE = 64;

@Injectable()
export class MenuSearchIndexService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MenuSearchIndexService.name);
  readonly collection: string;
  readonly dimensions: number;
  private collectionReady: Promise<void> | null = null;
  private draining: Promise<void> | null = null;
  private drainAgain = false;

  constructor(
    private readonly qdrant: QdrantService,
    private readonly ai: AiService,
    configService: ConfigService,
    @InjectModel(RestaurantMenuItem.name)
    private readonly menuItems: Model<RestaurantMenuItem>,
    @InjectModel(Workspace.name)
    private readonly workspaces: Model<Workspace>,
    @InjectModel(User.name)
    private readonly users: Model<User>,
  ) {
    this.collection = configService.get<string>(
      'QDRANT_MENU_ITEMS_COLLECTION',
      'vedora_menu_items_v1',
    );
    this.dimensions = configService.get<number>(
      'POST_SEARCH_EMBEDDING_DIMENSIONS',
      768,
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
        this.logger.warn(`Menu item indexing failed: ${String(error)}`);
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

  async remove(itemId: string): Promise<void> {
    try {
      await this.qdrant.delete(this.collection, {
        wait: true,
        points: [itemId],
      });
    } catch (error) {
      this.logger.warn(
        `Could not remove menu item ${itemId} from search: ${String(error)}`,
      );
    }
  }

  async removeMany(itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    await this.qdrant.delete(this.collection, { wait: true, points: itemIds });
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
    const rows = await this.menuItems
      .find({
        pageUserId: { $type: 'string' },
        isAvailable: true,
        searchIndexedAt: null,
      })
      .sort({ createdAt: 1, _id: 1 })
      .limit(BATCH_SIZE)
      .exec();
    if (rows.length === 0) return 0;

    const workspaceIds = [...new Set(rows.map((row) => row.workspaceId))];
    const pageUserIds = [
      ...new Set(
        rows
          .map((row) => row.pageUserId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];

    const [workspaces, pages] = await Promise.all([
      this.workspaces
        .find({
          _id: { $in: workspaceIds },
          status: VerificationStatus.APPROVED,
          pageUserId: { $type: 'string' },
        })
        .select('address pageUserId')
        .exec(),
      this.users
        .find({
          _id: { $in: pageUserIds },
          status: AccountStatus.ACTIVE,
        })
        .select('fullName')
        .exec(),
    ]);

    const workspaceById = new Map(workspaces.map((ws) => [ws.id, ws]));
    const pageById = new Map(pages.map((page) => [page.id, page]));

    const eligible: {
      item: RestaurantMenuItem;
      text: string;
      pageUserId: string;
    }[] = [];
    const staleIds: string[] = [];

    for (const item of rows) {
      const ws = workspaceById.get(item.workspaceId);
      const page = item.pageUserId ? pageById.get(item.pageUserId) : undefined;
      if (!ws || !page || ws.pageUserId !== page.id) {
        staleIds.push(item.id);
        continue;
      }
      const text = buildMenuItemSearchText(item, {
        name: page.fullName,
        address: ws.address,
      });
      eligible.push({ item, text, pageUserId: page.id });
    }

    if (staleIds.length > 0) {
      await this.removeMany(staleIds).catch(() => undefined);
    }

    if (eligible.length > 0) {
      let denseVectors: number[][] | null = null;
      try {
        const result = await this.ai.embedMany({
          model: 'posts',
          label: 'index-menu-items',
          values: eligible.map(
            ({ item, text }) => `title: ${item.name} | text: ${text}`,
          ),
        });
        denseVectors = result.embeddings;
      } catch (error) {
        this.logger.warn(
          `Menu item embedding failed, indexing sparse BM25 only: ${String(error)}`,
        );
      }

      await this.qdrant.upsert(this.collection, {
        wait: true,
        points: eligible.map(({ item, text, pageUserId }, index) => {
          const dense = denseVectors?.[index];
          return {
            id: item.id,
            vector: {
              ...(dense ? { [MENU_DENSE_VECTOR]: dense } : {}),
              [MENU_BM25_VECTOR]: menuBm25(text, false),
              [MENU_BM25_FOLDED_VECTOR]: menuBm25(text, true),
            },
            payload: {
              itemId: item.id,
              workspaceId: item.workspaceId,
              pageUserId,
            } satisfies MenuItemPointPayload,
          } as const;
        }),
      });
    }

    const indexedAt = new Date();
    for (const item of rows) {
      await this.menuItems
        .updateOne(
          { _id: item.id, updatedAt: item.updatedAt },
          { $set: { searchIndexedAt: indexedAt } },
        )
        .exec();
    }
    return rows.length;
  }

  private async createCollection(): Promise<void> {
    const size = this.dimensions;
    if ((await this.qdrant.collectionExists(this.collection)).exists) {
      const { config } = await this.qdrant.getCollection(this.collection);
      const vectors = config.params.vectors;
      const dense =
        vectors && !('size' in vectors)
          ? vectors[MENU_DENSE_VECTOR]
          : undefined;
      if (dense?.size !== size) {
        throw new Error(
          `Qdrant collection ${this.collection} does not hold ${size}-dimension "${MENU_DENSE_VECTOR}" vectors; use a new QDRANT_MENU_ITEMS_COLLECTION`,
        );
      }
      return;
    }

    await this.qdrant.createCollection(this.collection, {
      vectors: {
        [MENU_DENSE_VECTOR]: { size, distance: 'Cosine', on_disk: true },
      },
      sparse_vectors: {
        [MENU_BM25_VECTOR]: { modifier: 'idf' },
        [MENU_BM25_FOLDED_VECTOR]: { modifier: 'idf' },
      },
      quantization_config: { scalar: { type: 'int8', always_ram: true } },
    });
    await this.qdrant.createPayloadIndex(this.collection, {
      field_name: 'workspaceId',
      field_schema: 'keyword',
      wait: true,
    });
    await this.qdrant.createPayloadIndex(this.collection, {
      field_name: 'pageUserId',
      field_schema: 'keyword',
      wait: true,
    });

    const { modifiedCount } = await this.menuItems
      .updateMany(
        { searchIndexedAt: { $ne: null } },
        { $set: { searchIndexedAt: null } },
      )
      .exec();
    this.logger.log(
      `Created Qdrant collection ${this.collection}; reindexing ${modifiedCount} menu items`,
    );
  }
}
