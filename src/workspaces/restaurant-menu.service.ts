import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import {
  AccountStatus,
  RestaurantMenuItem,
  User,
  VerificationStatus,
  Workspace,
  WorkspaceMember,
} from '../mongo/models.js';
import { StorageService, StorageTarget } from '../storage/storage.service.js';
import {
  CreateMenuImageUploadDto,
  CreateRestaurantMenuItemDto,
  MAX_MENU_IMAGE_MB,
  MAX_MENU_SEARCH_RESULTS,
  MenuImageUploadDto,
  RestaurantMenuItemDto,
  RestaurantMenuListDto,
  RestaurantMenuSearchItemDto,
  RestaurantMenuSearchPageDto,
  SearchRestaurantMenuQueryDto,
  UpdateRestaurantMenuItemDto,
} from './dto/restaurant-menu.dto.js';
import { RestaurantReviewsService } from './restaurant-reviews.service.js';
import { MenuSearchIndexService } from './search/menu-search-index.service.js';
import { MenuSearchService } from './search/menu-search.service.js';

const IMAGE_EXTENSIONS: Record<
  CreateMenuImageUploadDto['contentType'],
  string
> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES = MAX_MENU_IMAGE_MB * 1024 * 1024;

export interface PlannerRestaurantDishSuggestion {
  id: string;
  name: string;
  category: string | null;
  priceVnd: number | null;
  description: string | null;
  imageUrl: string | null;
  restaurant: {
    pageUserId: string;
    username: string;
    name: string;
    avatarUrl: string | null;
    address: string;
    averageRating: number | null;
    reviewCount: number;
  };
  avoidedMatches: string[];
}

function toItemDto(item: RestaurantMenuItem): RestaurantMenuItemDto {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    pageUserId: item.pageUserId,
    name: item.name,
    description: item.description,
    category: item.category,
    priceVnd: item.priceVnd,
    imageUrl: item.imageUrl,
    isAvailable: item.isAvailable,
    position: item.position,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function findAvoidedMatches(
  item: { name: string; category: string | null; description: string | null },
  avoidedTerms: readonly string[],
): string[] {
  if (avoidedTerms.length === 0) return [];
  const haystack = [item.name, item.category, item.description]
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .toLowerCase();
  const matches: string[] = [];
  for (const term of avoidedTerms) {
    const clean = term.trim().toLowerCase();
    if (!clean || !haystack.includes(clean)) continue;
    if (!matches.includes(term)) matches.push(term);
  }
  return matches;
}

@Injectable()
export class RestaurantMenuService {
  constructor(
    @InjectModel(RestaurantMenuItem.name)
    private readonly menuItems: Model<RestaurantMenuItem>,
    @InjectModel(Workspace.name)
    private readonly workspaces: Model<Workspace>,
    @InjectModel(WorkspaceMember.name)
    private readonly members: Model<WorkspaceMember>,
    @InjectModel(User.name)
    private readonly users: Model<User>,
    private readonly storage: StorageService,
    private readonly menuSearchIndex: MenuSearchIndexService,
    private readonly menuSearch: MenuSearchService,
    private readonly reviews: RestaurantReviewsService,
  ) {}

  async createImageUpload(
    personId: string,
    workspaceId: string,
    dto: CreateMenuImageUploadDto,
  ): Promise<MenuImageUploadDto> {
    await this.requireMemberWorkspace(personId, workspaceId);
    if (dto.sizeBytes > MAX_IMAGE_BYTES) {
      throw new InvalidInputException(
        'BAD_REQUEST',
        `Menu image must be at most ${MAX_MENU_IMAGE_MB} MB`,
      );
    }
    const key = `restaurants/${workspaceId}/menu/${randomUUID()}.${IMAGE_EXTENSIONS[dto.contentType]}`;
    const upload = await this.storage.presignUpload(
      StorageTarget.Blogs,
      key,
      dto.contentType,
      dto.sizeBytes,
    );
    return {
      upload,
      url: this.storage.publicObjectUrl(StorageTarget.Blogs, key),
    };
  }

  async listForWorkspace(
    personId: string,
    workspaceId: string,
  ): Promise<RestaurantMenuListDto> {
    await this.requireMemberWorkspace(personId, workspaceId);
    const items = await this.menuItems
      .find({ workspaceId })
      .sort({ position: 1, createdAt: 1, _id: 1 })
      .exec();
    return { items: items.map(toItemDto) };
  }

  async create(
    personId: string,
    workspaceId: string,
    dto: CreateRestaurantMenuItemDto,
  ): Promise<RestaurantMenuItemDto> {
    const workspace = await this.requireMemberWorkspace(personId, workspaceId);
    this.validateImageUrl(dto.imageUrl);

    const position =
      dto.position ?? (await this.menuItems.countDocuments({ workspaceId }));
    const item = await this.menuItems.create({
      _id: randomUUID(),
      workspaceId,
      pageUserId: workspace.pageUserId,
      name: dto.name,
      description: dto.description ?? null,
      category: dto.category ?? null,
      priceVnd: dto.priceVnd ?? null,
      imageUrl: dto.imageUrl ?? null,
      isAvailable: dto.isAvailable ?? true,
      position,
      searchIndexedAt: null,
    });

    if (
      workspace.status === VerificationStatus.APPROVED &&
      workspace.pageUserId &&
      item.isAvailable
    ) {
      this.menuSearchIndex.schedule();
    }
    return toItemDto(item);
  }

  async update(
    personId: string,
    workspaceId: string,
    itemId: string,
    dto: UpdateRestaurantMenuItemDto,
  ): Promise<RestaurantMenuItemDto> {
    const workspace = await this.requireMemberWorkspace(personId, workspaceId);
    if (dto.imageUrl !== undefined) this.validateImageUrl(dto.imageUrl);

    const updates: Record<string, unknown> = {
      searchIndexedAt: null,
      pageUserId: workspace.pageUserId,
    };
    if (dto.name !== undefined) updates.name = dto.name;
    if (dto.description !== undefined) updates.description = dto.description;
    if (dto.category !== undefined) updates.category = dto.category;
    if (dto.priceVnd !== undefined) updates.priceVnd = dto.priceVnd;
    if (dto.imageUrl !== undefined) updates.imageUrl = dto.imageUrl;
    if (dto.isAvailable !== undefined) updates.isAvailable = dto.isAvailable;
    if (dto.position !== undefined) updates.position = dto.position;

    const updated = await this.menuItems
      .findOneAndUpdate(
        { _id: itemId, workspaceId },
        { $set: updates },
        { returnDocument: 'after' },
      )
      .exec();
    if (!updated) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Menu item not found');
    }

    if (!updated.isAvailable) {
      await this.menuSearchIndex.remove(updated.id);
    } else if (
      workspace.status === VerificationStatus.APPROVED &&
      workspace.pageUserId
    ) {
      this.menuSearchIndex.schedule();
    }
    return toItemDto(updated);
  }

  async remove(
    personId: string,
    workspaceId: string,
    itemId: string,
  ): Promise<void> {
    await this.requireMemberWorkspace(personId, workspaceId);
    const deleted = await this.menuItems
      .findOneAndDelete({ _id: itemId, workspaceId })
      .exec();
    if (!deleted) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Menu item not found');
    }
    await this.menuSearchIndex.remove(itemId);
  }

  async markWorkspaceDirty(
    workspaceId: string,
    pageUserId?: string,
  ): Promise<void> {
    const update: Record<string, unknown> = { searchIndexedAt: null };
    if (pageUserId !== undefined) update.pageUserId = pageUserId;
    await this.menuItems.updateMany({ workspaceId }, { $set: update }).exec();
    this.menuSearchIndex.schedule();
  }

  async listPublic(pageUserId: string): Promise<RestaurantMenuListDto> {
    const workspace = await this.workspaces
      .findOne({ pageUserId, status: VerificationStatus.APPROVED })
      .select('_id')
      .exec();
    const pageUser = await this.users
      .findOne({
        _id: pageUserId,
        status: AccountStatus.ACTIVE,
        emailVerifiedAt: { $ne: null },
      })
      .select('_id')
      .exec();
    if (!workspace || !pageUser) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Restaurant not found');
    }
    const items = await this.menuItems
      .find({ workspaceId: workspace.id })
      .sort({ isAvailable: -1, position: 1, createdAt: 1, _id: 1 })
      .exec();
    return { items: items.map(toItemDto) };
  }

  async search(
    query: SearchRestaurantMenuQueryDto,
  ): Promise<RestaurantMenuSearchPageDto> {
    const offset = query.cursor ?? 0;
    const limit = Math.min(query.limit, MAX_MENU_SEARCH_RESULTS - offset);
    if (limit <= 0) return { items: [], nextCursor: null };

    const { ids, hasMore } = await this.menuSearch.search(
      query.q,
      offset,
      limit,
    );
    if (ids.length === 0) return { items: [], nextCursor: null };

    const items = await this.hydrateSearchItems(ids, true);
    return {
      items,
      nextCursor:
        hasMore && offset + limit < MAX_MENU_SEARCH_RESULTS
          ? String(offset + limit)
          : null,
    };
  }

  async suggestForPlanner(
    query: string | undefined,
    limit: number,
    avoidedTerms: readonly string[],
  ): Promise<PlannerRestaurantDishSuggestion[]> {
    const trimmed = query?.trim();
    let candidates: RestaurantMenuSearchItemDto[];

    if (trimmed) {
      const { ids } = await this.menuSearch.search(trimmed, 0, limit);
      candidates =
        ids.length > 0 ? await this.hydrateSearchItems(ids, true) : [];
    } else {
      const rows = await this.menuItems
        .find({ pageUserId: { $type: 'string' }, isAvailable: true })
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit * 2)
        .exec();
      candidates = await this.hydrateSearchItems(
        rows.map((row) => row.id),
        false,
      );
      candidates = candidates.slice(0, limit);
    }

    const edible: PlannerRestaurantDishSuggestion[] = [];
    const flagged: PlannerRestaurantDishSuggestion[] = [];
    for (const item of candidates) {
      const avoidedMatches = findAvoidedMatches(item, avoidedTerms);
      const entry: PlannerRestaurantDishSuggestion = {
        id: item.id,
        name: item.name,
        category: item.category,
        priceVnd: item.priceVnd,
        description: item.description,
        imageUrl: item.imageUrl,
        restaurant: {
          pageUserId: item.restaurant.pageUserId,
          username: item.restaurant.username,
          name: item.restaurant.name,
          avatarUrl: item.restaurant.avatarUrl,
          address: item.restaurant.address,
          averageRating: item.restaurant.averageRating,
          reviewCount: item.restaurant.reviewCount,
        },
        avoidedMatches,
      };
      if (avoidedMatches.length > 0) flagged.push(entry);
      else edible.push(entry);
    }
    return [...edible, ...flagged];
  }

  private async hydrateSearchItems(
    ids: string[],
    pruneStale: boolean,
  ): Promise<RestaurantMenuSearchItemDto[]> {
    if (ids.length === 0) return [];
    const rows = await this.menuItems
      .find({ _id: { $in: ids }, isAvailable: true })
      .exec();
    const workspaceIds = [...new Set(rows.map((row) => row.workspaceId))];
    const pageUserIds = [
      ...new Set(
        rows
          .map((row) => row.pageUserId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];

    const [workspaces, pages, ratingStats] = await Promise.all([
      this.workspaces
        .find({
          _id: { $in: workspaceIds },
          status: VerificationStatus.APPROVED,
          pageUserId: { $type: 'string' },
        })
        .exec(),
      this.users
        .find({
          _id: { $in: pageUserIds },
          status: AccountStatus.ACTIVE,
          emailVerifiedAt: { $ne: null },
        })
        .select('username fullName avatarUrl')
        .exec(),
      this.reviews.summariesByPageUserIds(pageUserIds),
    ]);

    const itemById = new Map(rows.map((item) => [item.id, item]));
    const workspaceById = new Map(workspaces.map((ws) => [ws.id, ws]));
    const pageById = new Map(pages.map((page) => [page.id, page]));

    const result: RestaurantMenuSearchItemDto[] = [];
    const staleIds: string[] = [];

    for (const id of ids) {
      const item = itemById.get(id);
      const workspace = item ? workspaceById.get(item.workspaceId) : undefined;
      const page =
        item?.pageUserId && workspace?.pageUserId === item.pageUserId
          ? pageById.get(item.pageUserId)
          : undefined;
      if (!item || !workspace || !page) {
        staleIds.push(id);
        continue;
      }
      const [longitude, latitude] = workspace.location.coordinates;
      const stats = ratingStats.get(page.id);
      result.push({
        id: item.id,
        name: item.name,
        description: item.description,
        category: item.category,
        priceVnd: item.priceVnd,
        imageUrl: item.imageUrl,
        restaurant: {
          pageUserId: page.id,
          username: page.username,
          name: page.fullName,
          avatarUrl: page.avatarUrl,
          address: workspace.address,
          longitude,
          latitude,
          averageRating: stats?.averageRating ?? null,
          reviewCount: stats?.reviewCount ?? 0,
        },
      });
    }

    if (pruneStale && staleIds.length > 0) {
      void this.menuSearch.prune(staleIds).catch(() => undefined);
    }
    return result;
  }

  private async requireMemberWorkspace(
    personId: string,
    workspaceId: string,
  ): Promise<Workspace> {
    const [workspace, membership] = await Promise.all([
      this.workspaces.findOne({ _id: workspaceId }).exec(),
      this.members.exists({ workspaceId, userId: personId }).exec(),
    ]);
    if (!workspace || !membership) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Page not found');
    }
    return workspace;
  }

  private validateImageUrl(url: string | null | undefined): void {
    if (!url) return;
    if (this.storage.keyFromPublicUrl(StorageTarget.Blogs, url) !== null) {
      return;
    }
    throw new InvalidInputException(
      'BAD_REQUEST',
      'Menu image must be uploaded through Vedora storage',
    );
  }
}
