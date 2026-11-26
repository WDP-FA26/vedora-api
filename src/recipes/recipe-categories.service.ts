import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination/index.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { isUniqueViolation } from '../mongo/errors.js';
import { MongoService } from '../mongo/mongo.service.js';
import {
  RecipeCategory,
  RecipeCategoryIcon,
  RecipeTag,
} from '../mongo/models.js';
import {
  RecipeCategoryDto,
  ReorderRecipeCategoriesDto,
  SaveRecipeCategoryDto,
} from './dto/recipe-category.dto.js';

/** Gap between neighbours, so the order stays readable in the database. */
const SORT_STEP = 10;

type DefaultCategory = Pick<
  RecipeCategory,
  'name' | 'baseTag' | 'icon' | 'sortOrder'
>;

/** The nine dish kinds the app started with, created once on an empty database. */
const DEFAULT_CATEGORIES: readonly DefaultCategory[] = [
  {
    name: 'Món canh, súp',
    baseTag: RecipeTag.SOUP,
    icon: RecipeCategoryIcon.SOUP,
    sortOrder: 10,
  },
  {
    name: 'Salad, món gỏi',
    baseTag: RecipeTag.SALAD,
    icon: RecipeCategoryIcon.SALAD,
    sortOrder: 20,
  },
  {
    name: 'Món cơm',
    baseTag: RecipeTag.RICE,
    icon: RecipeCategoryIcon.POT,
    sortOrder: 30,
  },
  {
    name: 'Món bún, mì, phở',
    baseTag: RecipeTag.NOODLES,
    icon: RecipeCategoryIcon.WHEAT,
    sortOrder: 40,
  },
  {
    name: 'Món xào, chiên, kho',
    baseTag: RecipeTag.STIR_FRY,
    icon: RecipeCategoryIcon.FLAME,
    sortOrder: 50,
  },
  {
    name: 'Bánh mì, bánh mặn',
    baseTag: RecipeTag.BREAD,
    icon: RecipeCategoryIcon.SANDWICH,
    sortOrder: 60,
  },
  {
    name: 'Tráng miệng',
    baseTag: RecipeTag.DESSERT,
    icon: RecipeCategoryIcon.CAKE,
    sortOrder: 70,
  },
  {
    name: 'Đồ uống',
    baseTag: RecipeTag.DRINK,
    icon: RecipeCategoryIcon.COFFEE,
    sortOrder: 80,
  },
  {
    name: 'Ăn vặt',
    baseTag: RecipeTag.SNACK,
    icon: RecipeCategoryIcon.COOKIE,
    sortOrder: 90,
  },
];

@Injectable()
export class RecipeCategoriesService implements OnApplicationBootstrap {
  constructor(
    @InjectModel(RecipeCategory.name)
    private readonly categories: Model<RecipeCategory>,
    private readonly mongo: MongoService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.createDefaultsIfEmpty();
  }

  /** Seeds the defaults only while the collection is empty, so deleted ones stay deleted. */
  async createDefaultsIfEmpty(): Promise<void> {
    const existing = await this.categories.estimatedDocumentCount().exec();
    if (existing > 0) return;
    const rows = DEFAULT_CATEGORIES.map((category) => ({
      _id: randomUUID(),
      description: null,
      hidden: false,
      ...category,
    }));
    try {
      await this.categories.insertMany(rows, { ordered: false });
    } catch (error: unknown) {
      // Another instance seeded at the same moment; its rows win.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  async findAll(
    query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<RecipeCategoryDto>> {
    const { skip, take } = getPaginationArgs(query);
    const [rows, totalItems] = await Promise.all([
      this.categories
        .find()
        .sort({ sortOrder: 1, _id: 1 })
        .skip(skip)
        .limit(take)
        .exec(),
      this.categories.countDocuments(),
    ]);
    return createPaginatedResponse(rows.map(toDto), totalItems, query);
  }

  /** A new category goes to the end of the list. */
  async create(dto: SaveRecipeCategoryDto): Promise<RecipeCategoryDto> {
    const id = randomUUID();
    const last = await this.categories
      .findOne()
      .sort({ sortOrder: -1, _id: -1 })
      .select('sortOrder')
      .exec();
    const sortOrder = (last?.sortOrder ?? 0) + SORT_STEP;
    await this.write(async () => {
      await this.categories.create({ _id: id, sortOrder, ...toFields(dto) });
    });
    return this.findOne(id);
  }

  /** `ids` is every category, in the new order; they are renumbered 10, 20, 30… */
  async reorder(dto: ReorderRecipeCategoriesDto): Promise<void> {
    await this.mongo.withTransaction(async (session) => {
      const rows = await this.categories
        .find()
        .select('_id')
        .session(session)
        .exec();
      const known = new Set(rows.map(({ id }) => id));
      const sameSet =
        dto.ids.length === known.size && dto.ids.every((id) => known.has(id));
      if (!sameSet) {
        throw new InvalidInputException(
          'ORDER_MISMATCH',
          'ids must list every recipe category exactly once',
        );
      }
      const updates = dto.ids.map((id, index) => ({
        updateOne: {
          filter: { _id: id },
          update: { $set: { sortOrder: (index + 1) * SORT_STEP } },
        },
      }));
      await this.categories.bulkWrite(updates, { session });
    });
  }

  async update(
    id: string,
    dto: SaveRecipeCategoryDto,
  ): Promise<RecipeCategoryDto> {
    await this.write(async () => {
      const updated = await this.categories
        .updateOne({ _id: id }, { $set: toFields(dto) })
        .exec();
      if (updated.matchedCount === 0) throw notFound();
    });
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    const { deletedCount } = await this.categories
      .deleteOne({ _id: id })
      .exec();
    if (deletedCount === 0) throw notFound();
  }

  private async findOne(id: string): Promise<RecipeCategoryDto> {
    const row = await this.categories.findOne({ _id: id }).exec();
    if (!row) throw notFound();
    return toDto(row);
  }

  private async write(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      throw new StateConflictException(
        'NAME_TAKEN',
        'Recipe category name is already used',
      );
    }
  }
}

function toFields(dto: SaveRecipeCategoryDto) {
  return {
    name: dto.name,
    description: dto.description || null,
    baseTag: dto.baseTag,
    icon: dto.icon ?? RecipeCategoryIcon.UTENSILS,
    hidden: dto.hidden ?? false,
  };
}

function toDto(row: RecipeCategory): RecipeCategoryDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    baseTag: row.baseTag,
    icon: row.icon,
    sortOrder: row.sortOrder,
    hidden: row.hidden,
    createdAt: row.createdAt,
  };
}

function notFound(): ResourceNotFoundException {
  return new ResourceNotFoundException(
    'NOT_FOUND',
    'Recipe category not found',
  );
}
