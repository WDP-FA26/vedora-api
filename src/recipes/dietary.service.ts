import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  Ingredient,
  IngredientGroup,
  IngredientGroupMember,
  User,
} from '../mongo/models';
import { allExist } from '../mongo/references';
import {
  DietaryOptionsDto,
  DietaryRestrictionsDto,
  SaveDietaryRestrictionsDto,
} from './dto/dietary.dto';
import { badRequest } from './recipe-errors';

/** What a user does not eat (ingredients and whole groups) and the ingredients they like. Never shown to others. */
@Injectable()
export class DietaryService {
  constructor(
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
    @InjectModel(IngredientGroup.name)
    private readonly groups: Model<IngredientGroup>,
    @InjectModel(IngredientGroupMember.name)
    private readonly members: Model<IngredientGroupMember>,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  /** Every ingredient, and the groups admins marked as food categories. */
  async options(): Promise<DietaryOptionsDto> {
    const [ingredients, groups] = await Promise.all([
      this.ingredients.find().sort({ name: 1 }).exec(),
      this.groups.find({ dietary: true }).sort({ name: 1 }).exec(),
    ]);
    const members = await this.members
      .find({ groupId: { $in: groups.map(({ id }) => id) } })
      .exec();
    const nameOf = new Map(ingredients.map(({ id, name }) => [id, name]));
    return {
      ingredients: ingredients.map(({ id, name, aliases }) => ({
        id,
        name,
        aliases: [...aliases],
      })),
      groups: groups.map(({ id, name }) => ({
        id,
        name,
        ingredients: members
          .filter(({ groupId }) => groupId === id)
          .map(({ ingredientId }) => nameOf.get(ingredientId) ?? '')
          .sort(),
      })),
    };
  }

  async find(userId: string): Promise<DietaryRestrictionsDto> {
    const user = await this.preferences(userId);
    const [ingredients, groups] = await Promise.all([
      this.ingredients
        .find({
          _id: {
            $in: [...user.avoidedIngredientIds, ...user.likedIngredientIds],
          },
        })
        .select('name')
        .sort({ name: 1 })
        .exec(),
      this.groups
        .find({ _id: { $in: [...user.avoidedGroupIds] } })
        .select('name')
        .sort({ name: 1 })
        .exec(),
    ]);
    const liked = new Set(user.likedIngredientIds);
    return {
      ingredients: ingredients
        .filter(({ id }) => !liked.has(id))
        .map(({ id, name }) => ({ id, name })),
      groups: groups.map(({ id, name }) => ({ id, name })),
      liked: ingredients
        .filter(({ id }) => liked.has(id))
        .map(({ id, name }) => ({ id, name })),
    };
  }

  /** Every ingredient the user avoids, directly or through a group. */
  async avoidedIngredientIds(userId: string): Promise<Set<string>> {
    const user = await this.preferences(userId);
    const viaGroups = await this.members
      .find({ groupId: { $in: [...user.avoidedGroupIds] } })
      .select('ingredientId')
      .exec();
    return new Set([
      ...user.avoidedIngredientIds,
      ...viaGroups.map(({ ingredientId }) => ingredientId),
    ]);
  }

  async replace(
    userId: string,
    dto: SaveDietaryRestrictionsDto,
  ): Promise<DietaryRestrictionsDto> {
    const avoided = new Set(dto.ingredientIds);
    if (dto.likedIngredientIds.some((id) => avoided.has(id))) {
      throw badRequest(
        'CONFLICTING_PREFERENCE',
        'An ingredient cannot be both liked and avoided',
      );
    }
    const [ingredients, groups] = await Promise.all([
      allExist([...dto.ingredientIds, ...dto.likedIngredientIds], (ids) =>
        this.ingredients.countDocuments({ _id: { $in: ids } }),
      ),
      allExist(dto.groupIds, (ids) =>
        this.groups.countDocuments({ _id: { $in: ids } }),
      ),
    ]);
    if (!ingredients || !groups) {
      throw badRequest(
        'UNKNOWN_REFERENCE',
        'An ingredient or group in the request does not exist',
      );
    }
    await this.users
      .findOneAndUpdate(
        { _id: userId },
        {
          $set: {
            avoidedIngredientIds: dto.ingredientIds,
            avoidedGroupIds: dto.groupIds,
            likedIngredientIds: dto.likedIngredientIds,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    return this.find(userId);
  }

  private async preferences(userId: string) {
    const user = await this.users
      .findOne({ _id: userId })
      .select('avoidedIngredientIds avoidedGroupIds likedIngredientIds')
      .exec();
    return (
      user ?? {
        avoidedIngredientIds: [],
        avoidedGroupIds: [],
        likedIngredientIds: [],
      }
    );
  }
}
