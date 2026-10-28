import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { ClientSession, Model } from 'mongoose';
import { lockDocument } from '../mongo/document-lock.js';
import { Recipe, RecipeRating, User } from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import {
  MyRecipeRatingDto,
  RecipeRatingSummaryDto,
} from './dto/recipe-rating.dto.js';

@Injectable()
export class RecipeRatingsService {
  constructor(
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
    @InjectModel(RecipeRating.name)
    private readonly recipeRatings: Model<RecipeRating>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly mongo: MongoService,
  ) {}

  async summary(recipeId: string): Promise<RecipeRatingSummaryDto> {
    await this.requireRecipe(recipeId);
    return this.aggregate(recipeId);
  }

  async mine(recipeId: string, userId: string): Promise<MyRecipeRatingDto> {
    await this.requireRecipe(recipeId);
    const rating = await this.recipeRatings
      .findOne({ recipeId, userId })
      .select('value')
      .exec();
    return {
      ...(await this.aggregate(recipeId)),
      myRating: rating?.value ?? null,
    };
  }

  /** Caller identity comes from the guard. null removes the caller's score. */
  async set(
    recipeId: string,
    userId: string,
    value: number | null,
  ): Promise<MyRecipeRatingDto> {
    return this.mongo.withTransaction(async (session) => {
      // Account -> recipe lock order. Account updates/deletion cannot race
      // verification, and concurrent scores on a recipe settle sequentially.
      await lockDocument(this.mongo, session, 'user', userId);
      const actor = await this.users
        .findOne({ _id: userId })
        .session(session)
        .exec();
      if (!actor) throw new UnauthorizedException('Account no longer exists');
      if (value !== null && !actor.emailVerifiedAt) {
        throw new ForbiddenException({
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Verify your email before rating a recipe',
        });
      }

      await lockDocument(this.mongo, session, 'recipe', recipeId);
      const recipe = await this.recipes
        .findOne({ _id: recipeId })
        .session(session)
        .exec();
      if (!recipe) throw new NotFoundException('Recipe not found');
      if (value !== null && recipe.createdById === userId) {
        throw new ForbiddenException({
          code: 'SELF_RATING_NOT_ALLOWED',
          message: 'You cannot rate your own recipe',
        });
      }

      if (value === null) {
        await this.recipeRatings
          .deleteOne({ recipeId, userId }, { session })
          .exec();
      } else {
        const now = new Date();
        await this.recipeRatings
          .updateOne(
            { recipeId, userId },
            {
              $set: { value, updatedAt: now },
              $setOnInsert: { _id: randomUUID(), createdAt: now },
            },
            { upsert: true, session },
          )
          .exec();
      }
      return {
        ...(await this.aggregate(recipeId, session)),
        myRating: value,
      };
    });
  }

  private async requireRecipe(recipeId: string) {
    const recipe = await this.recipes
      .findOne({ _id: recipeId })
      .select('_id')
      .exec();
    if (!recipe) throw new NotFoundException('Recipe not found');
  }

  /**
   * The count and mean of the recipe's scores. No stored aggregate to drift
   * under retries/account deletion. Until the account lifecycle feature
   * exists, verified email is the eligibility gate. Inside `set` it runs in
   * the transaction, so the result includes that write.
   */
  private async aggregate(
    recipeId: string,
    session?: ClientSession,
  ): Promise<RecipeRatingSummaryDto> {
    const [stats] = await this.recipeRatings
      .aggregate<{ count: number; sum: number }>(
        [
          { $match: { recipeId } },
          {
            $lookup: {
              from: 'users',
              localField: 'userId',
              foreignField: '_id',
              as: 'user',
            },
          },
          { $match: { 'user.emailVerifiedAt': { $ne: null } } },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              sum: { $sum: '$value' },
            },
          },
        ],
        { session },
      )
      .exec();
    const ratingCount = stats?.count ?? 0;
    return {
      recipeId,
      ratingCount,
      averageRating:
        ratingCount === 0
          ? null
          : Math.round((stats.sum * 10) / ratingCount) / 10,
    };
  }
}
