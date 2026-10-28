import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { ClientSession, Model } from 'mongoose';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination/index.js';
import { isUniqueViolation } from '../mongo/errors.js';
import { Ingredient, IngredientGroup, Recipe } from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { allExist } from '../mongo/references.js';
import {
  IngredientDto,
  IngredientGroupDto,
  SaveIngredientDto,
  SaveIngredientGroupDto,
} from './dto/ingredient.dto.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';

/** The ingredient catalog and the groups that share incompatibility rules. */
@Injectable()
export class IngredientsService {
  constructor(
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
    @InjectModel(IngredientGroup.name)
    private readonly groups: Model<IngredientGroup>,
    @InjectModel(Recipe.name)
    private readonly recipes: Model<Recipe>,
    private readonly mongo: MongoService,
  ) {}

  async findAll(
    query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<IngredientDto>> {
    const { skip, take } = getPaginationArgs(query);
    const [rows, totalItems] = await Promise.all([
      this.ingredients
        .find()
        .sort({ name: 1, _id: 1 })
        .skip(skip)
        .limit(take)
        .exec(),
      this.ingredients.countDocuments(),
    ]);
    return createPaginatedResponse(
      await this.toIngredients(rows),
      totalItems,
      query,
    );
  }

  async create(dto: SaveIngredientDto): Promise<IngredientDto> {
    await this.requireGroups(dto.groupIds);
    const id = randomUUID();
    await this.write('Ingredient', async (session) => {
      await this.ingredients.create(
        [
          {
            _id: id,
            name: dto.name,
            aliases: dto.aliases ?? [],
          },
        ],
        { session },
      );
      if (dto.groupIds?.length) {
        await this.groups
          .updateMany(
            { _id: { $in: dto.groupIds } },
            { $addToSet: { ingredientIds: id } },
            { session, timestamps: false },
          )
          .exec();
      }
    });
    return this.findIngredient(id);
  }

  async update(id: string, dto: SaveIngredientDto): Promise<IngredientDto> {
    await this.requireGroups(dto.groupIds);
    await this.write('Ingredient', async (session) => {
      const updated = await this.ingredients
        .updateOne(
          { _id: id },
          {
            $set: {
              name: dto.name,
              aliases: dto.aliases ?? [],
            },
          },
          { session },
        )
        .exec();
      if (updated.matchedCount === 0) {
        throw new ResourceNotFoundException(
          'NOT_FOUND',
          'Ingredient not found',
        );
      }
      const groupIds = dto.groupIds ?? [];
      await this.groups
        .updateMany(
          { _id: { $nin: groupIds }, ingredientIds: id },
          { $pull: { ingredientIds: id } },
          { session, timestamps: false },
        )
        .exec();
      if (groupIds.length > 0) {
        await this.groups
          .updateMany(
            { _id: { $in: groupIds } },
            { $addToSet: { ingredientIds: id } },
            { session, timestamps: false },
          )
          .exec();
      }
    });
    return this.findIngredient(id);
  }

  /** Refused while a recipe still uses the ingredient. */
  async remove(id: string): Promise<void> {
    await this.mongo.withTransaction(async (session) => {
      const inUse = await this.recipes
        .countDocuments({ 'ingredients.ingredientId': id })
        .limit(1)
        .session(session)
        .exec();
      if (inUse > 0) {
        throw new StateConflictException(
          'INGREDIENT_IN_USE',
          'Remove the ingredient from its recipes first',
        );
      }
      const { deletedCount } = await this.ingredients
        .deleteOne({ _id: id }, { session })
        .exec();
      if (deletedCount === 0) {
        throw new ResourceNotFoundException(
          'NOT_FOUND',
          'Ingredient not found',
        );
      }
    });
  }

  async findAllGroups(
    query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<IngredientGroupDto>> {
    const { skip, take } = getPaginationArgs(query);
    const [rows, totalItems] = await Promise.all([
      this.groups
        .find()
        .sort({ name: 1, _id: 1 })
        .skip(skip)
        .limit(take)
        .exec(),
      this.groups.countDocuments(),
    ]);
    return createPaginatedResponse(
      await this.toGroups(rows),
      totalItems,
      query,
    );
  }

  async createGroup(dto: SaveIngredientGroupDto): Promise<IngredientGroupDto> {
    await this.requireIngredients(dto.ingredientIds);
    const id = randomUUID();
    await this.write('Ingredient group', async (session) => {
      await this.groups.create(
        [
          {
            _id: id,
            name: dto.name,
            description: dto.description || null,
            dietary: dto.dietary ?? false,
            ingredientIds: dto.ingredientIds ?? [],
          },
        ],
        { session },
      );
    });
    return this.findGroup(id);
  }

  async updateGroup(
    id: string,
    dto: SaveIngredientGroupDto,
  ): Promise<IngredientGroupDto> {
    await this.requireIngredients(dto.ingredientIds);
    await this.write('Ingredient group', async (session) => {
      const updated = await this.groups
        .updateOne(
          { _id: id },
          {
            $set: {
              name: dto.name,
              description: dto.description || null,
              dietary: dto.dietary ?? false,
              ingredientIds: dto.ingredientIds ?? [],
            },
          },
          { session },
        )
        .exec();
      if (updated.matchedCount === 0) {
        throw new ResourceNotFoundException(
          'NOT_FOUND',
          'Ingredient group not found',
        );
      }
    });
    return this.findGroup(id);
  }

  /** Also deletes the rules that name the group and pulls it from user preferences. */
  async removeGroup(id: string): Promise<void> {
    await this.mongo.withTransaction(async (session) => {
      const { deletedCount } = await this.groups
        .deleteOne({ _id: id }, { session })
        .exec();
      if (deletedCount === 0) {
        throw new ResourceNotFoundException(
          'NOT_FOUND',
          'Ingredient group not found',
        );
      }
    });
  }

  /** Runs a catalog write; a duplicate name is a 409. */
  private async write(
    subject: string,
    run: (session: ClientSession) => Promise<void>,
  ): Promise<void> {
    try {
      await this.mongo.withTransaction(run);
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      throw new StateConflictException(
        'NAME_TAKEN',
        `${subject} name is already used`,
      );
    }
  }

  private async requireGroups(ids: string[] | undefined): Promise<void> {
    const found = await allExist(this.groups, ids ?? []);
    if (!found)
      throw new InvalidInputException(
        'UNKNOWN_REFERENCE',
        'An id in the request does not exist',
      );
  }

  private async requireIngredients(ids: string[] | undefined): Promise<void> {
    const found = await allExist(this.ingredients, ids ?? []);
    if (!found)
      throw new InvalidInputException(
        'UNKNOWN_REFERENCE',
        'An id in the request does not exist',
      );
  }

  private async findIngredient(id: string): Promise<IngredientDto> {
    const row = await this.ingredients.findOne({ _id: id }).exec();
    if (!row)
      throw new ResourceNotFoundException('NOT_FOUND', 'Ingredient not found');
    const [dto] = await this.toIngredients([row]);
    return dto;
  }

  private async findGroup(id: string): Promise<IngredientGroupDto> {
    const row = await this.groups.findOne({ _id: id }).exec();
    if (!row)
      throw new ResourceNotFoundException(
        'NOT_FOUND',
        'Ingredient group not found',
      );
    const [dto] = await this.toGroups([row]);
    return dto;
  }

  /** Adds each ingredient's groups and how many recipes use it. */
  private async toIngredients(rows: Ingredient[]): Promise<IngredientDto[]> {
    const ids = rows.map(({ id }) => id);
    const [groups, recipeCounts] = await Promise.all([
      this.groups.find({ ingredientIds: { $in: ids } }).exec(),
      this.recipes.aggregate<{ _id: string; count: number }>([
        { $match: { 'ingredients.ingredientId': { $in: ids } } },
        { $unwind: '$ingredients' },
        { $match: { 'ingredients.ingredientId': { $in: ids } } },
        { $group: { _id: '$ingredients.ingredientId', count: { $sum: 1 } } },
      ]),
    ]);
    const recipeCount = new Map(
      recipeCounts.map((row) => [row._id, row.count]),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      aliases: [...row.aliases],
      groups: groups
        .filter((group) => group.ingredientIds.includes(row.id))
        .map((group) => ({ id: group.id, name: group.name }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      recipeCount: recipeCount.get(row.id) ?? 0,
      createdAt: row.createdAt,
    }));
  }

  /** Adds each group's ingredients. */
  private async toGroups(
    rows: IngredientGroup[],
  ): Promise<IngredientGroupDto[]> {
    const ingredientIds = [
      ...new Set(rows.flatMap((row) => row.ingredientIds)),
    ];
    const ingredients = await this.ingredients
      .find({ _id: { $in: ingredientIds } })
      .exec();
    const ingredientById = new Map(
      ingredients.map((ingredient) => [ingredient.id, ingredient]),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      dietary: row.dietary,
      ingredients: row.ingredientIds
        .flatMap((ingredientId) => {
          const ingredient = ingredientById.get(ingredientId);
          return ingredient
            ? [{ id: ingredient.id, name: ingredient.name }]
            : [];
        })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      createdAt: row.createdAt,
    }));
  }
}
