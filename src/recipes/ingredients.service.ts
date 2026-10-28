import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import type { Model } from 'mongoose';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination';
import { isUniqueViolation } from '../mongo/errors';
import {
  Ingredient,
  IngredientGroup,
  IngredientGroupMember,
  RecipeIngredient,
  Stored,
  User,
} from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';
import { allExist } from '../mongo/references';
import {
  deleteWithReferences,
  RestrictedDeleteError,
} from '../mongo/relations';
import {
  IngredientDto,
  IngredientGroupDto,
  SaveIngredientDto,
  SaveIngredientGroupDto,
} from './dto/ingredient.dto';
import { badRequest, conflict } from './recipe-errors';

/** The ingredient catalog and the groups that share incompatibility rules. */
@Injectable()
export class IngredientsService {
  constructor(
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
    @InjectModel(IngredientGroup.name)
    private readonly groups: Model<IngredientGroup>,
    @InjectModel(IngredientGroupMember.name)
    private readonly members: Model<IngredientGroupMember>,
    @InjectModel(RecipeIngredient.name)
    private readonly recipeIngredients: Model<RecipeIngredient>,
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
      const now = new Date();
      await this.collections.ingredients.insertOne(
        {
          _id: id,
          name: dto.name,
          aliases: dto.aliases ?? [],
          createdAt: now,
          updatedAt: now,
        },
        { session },
      );
      await this.addMembers(
        session,
        (dto.groupIds ?? []).map((groupId) => ({ groupId, ingredientId: id })),
      );
    });
    return this.findIngredient(id);
  }

  async update(id: string, dto: SaveIngredientDto): Promise<IngredientDto> {
    await this.requireGroups(dto.groupIds);
    await this.write('Ingredient', async (session) => {
      const updated = await this.collections.ingredients.updateOne(
        { _id: id },
        {
          $set: {
            name: dto.name,
            aliases: dto.aliases ?? [],
            updatedAt: new Date(),
          },
        },
        { session },
      );
      if (updated.matchedCount === 0) {
        throw new NotFoundException('Ingredient not found');
      }
      await this.collections.members.deleteMany(
        { ingredientId: id },
        { session },
      );
      await this.addMembers(
        session,
        (dto.groupIds ?? []).map((groupId) => ({ groupId, ingredientId: id })),
      );
    });
    return this.findIngredient(id);
  }

  /** Refused while a recipe still uses the ingredient. */
  async remove(id: string): Promise<void> {
    try {
      await this.mongo.withTransaction(async (session) => {
        const deleted = await deleteWithReferences(
          this.mongo.db,
          session,
          'ingredients',
          { _id: id },
        );
        if (deleted === 0) throw new NotFoundException('Ingredient not found');
        await this.forgetPreference(session, id, [
          'avoidedIngredientIds',
          'likedIngredientIds',
        ]);
      });
    } catch (error: unknown) {
      if (error instanceof RestrictedDeleteError) {
        throw conflict(
          'INGREDIENT_IN_USE',
          'Remove the ingredient from its recipes first',
        );
      }
      throw error;
    }
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
      const now = new Date();
      await this.collections.groups.insertOne(
        {
          _id: id,
          name: dto.name,
          description: dto.description || null,
          dietary: dto.dietary ?? false,
          createdAt: now,
          updatedAt: now,
        },
        { session },
      );
      await this.addMembers(
        session,
        (dto.ingredientIds ?? []).map((ingredientId) => ({
          groupId: id,
          ingredientId,
        })),
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
      const updated = await this.collections.groups.updateOne(
        { _id: id },
        {
          $set: {
            name: dto.name,
            description: dto.description || null,
            dietary: dto.dietary ?? false,
            updatedAt: new Date(),
          },
        },
        { session },
      );
      if (updated.matchedCount === 0) {
        throw new NotFoundException('Ingredient group not found');
      }
      await this.collections.members.deleteMany({ groupId: id }, { session });
      await this.addMembers(
        session,
        (dto.ingredientIds ?? []).map((ingredientId) => ({
          groupId: id,
          ingredientId,
        })),
      );
    });
    return this.findGroup(id);
  }

  /** Also deletes the rules that name the group. */
  async removeGroup(id: string): Promise<void> {
    await this.mongo.withTransaction(async (session) => {
      const deleted = await deleteWithReferences(
        this.mongo.db,
        session,
        'ingredient_groups',
        { _id: id },
      );
      if (deleted === 0) {
        throw new NotFoundException('Ingredient group not found');
      }
      await this.forgetPreference(session, id, ['avoidedGroupIds']);
    });
  }

  private get collections() {
    const database = this.mongo.db;
    return {
      ingredients: database.collection<Stored<Ingredient>>('ingredients'),
      groups: database.collection<Stored<IngredientGroup>>('ingredient_groups'),
      members: database.collection<Stored<IngredientGroupMember>>(
        'ingredient_group_members',
      ),
    };
  }

  private async addMembers(
    session: ClientSession,
    members: { groupId: string; ingredientId: string }[],
  ): Promise<void> {
    if (members.length === 0) return;
    await this.collections.members.insertMany(
      members.map((member) => ({ _id: randomUUID(), ...member })),
      { session },
    );
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
      throw conflict('NAME_TAKEN', `${subject} name is already used`);
    }
  }

  /** Pulls a deleted id out of users' dietary preference lists. */
  private async forgetPreference(
    session: ClientSession,
    id: string,
    fields: (
      'avoidedIngredientIds' | 'likedIngredientIds' | 'avoidedGroupIds'
    )[],
  ): Promise<void> {
    await this.mongo.db
      .collection<Stored<User>>('users')
      .updateMany(
        { $or: fields.map((field) => ({ [field]: id })) },
        { $pull: Object.fromEntries(fields.map((field) => [field, id])) },
        { session },
      );
  }

  private async requireGroups(ids: string[] | undefined): Promise<void> {
    const found = await allExist(this.groups, ids ?? []);
    if (!found) throw unknownReference();
  }

  private async requireIngredients(ids: string[] | undefined): Promise<void> {
    const found = await allExist(this.ingredients, ids ?? []);
    if (!found) throw unknownReference();
  }

  private async findIngredient(id: string): Promise<IngredientDto> {
    const row = await this.ingredients.findOne({ _id: id }).exec();
    if (!row) throw new NotFoundException('Ingredient not found');
    const [dto] = await this.toIngredients([row]);
    return dto;
  }

  private async findGroup(id: string): Promise<IngredientGroupDto> {
    const row = await this.groups.findOne({ _id: id }).exec();
    if (!row) throw new NotFoundException('Ingredient group not found');
    const [dto] = await this.toGroups([row]);
    return dto;
  }

  /** Adds each ingredient's groups and how many recipes use it. */
  private async toIngredients(rows: Ingredient[]): Promise<IngredientDto[]> {
    const ids = rows.map(({ id }) => id);
    const [members, recipeCounts] = await Promise.all([
      this.members.find({ ingredientId: { $in: ids } }).exec(),
      this.recipeIngredients.aggregate<{ _id: string; count: number }>([
        { $match: { ingredientId: { $in: ids } } },
        { $group: { _id: '$ingredientId', count: { $sum: 1 } } },
      ]),
    ]);
    const groupIds = [...new Set(members.map(({ groupId }) => groupId))];
    const groups = await this.groups.find({ _id: { $in: groupIds } }).exec();
    const groupById = new Map(groups.map((group) => [group.id, group]));
    const recipeCount = new Map(
      recipeCounts.map((row) => [row._id, row.count]),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      aliases: [...row.aliases],
      groups: members
        .filter(({ ingredientId }) => ingredientId === row.id)
        .flatMap(({ groupId }) => {
          const group = groupById.get(groupId);
          return group ? [{ id: group.id, name: group.name }] : [];
        })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      recipeCount: recipeCount.get(row.id) ?? 0,
      createdAt: row.createdAt,
    }));
  }

  /** Adds each group's ingredients. */
  private async toGroups(
    rows: IngredientGroup[],
  ): Promise<IngredientGroupDto[]> {
    const members = await this.members
      .find({ groupId: { $in: rows.map(({ id }) => id) } })
      .exec();
    const ingredientIds = [
      ...new Set(members.map(({ ingredientId }) => ingredientId)),
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
      ingredients: members
        .filter(({ groupId }) => groupId === row.id)
        .flatMap(({ ingredientId }) => {
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

const unknownReference = () =>
  badRequest('UNKNOWN_REFERENCE', 'An id in the request does not exist');
