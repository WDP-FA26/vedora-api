import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  MyRecipeRatingDto,
  RecipeRatingSummaryDto,
} from './dto/recipe-rating.dto';

@Injectable()
export class RecipeRatingsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(recipeId: string): Promise<RecipeRatingSummaryDto> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.requireRecipe(tx, recipeId);
        return this.aggregate(tx, recipeId);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async mine(recipeId: string, userId: string): Promise<MyRecipeRatingDto> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.requireRecipe(tx, recipeId);
        const rating = await tx.recipeRating.findUnique({
          where: { recipeId_userId: { recipeId, userId } },
          select: { value: true },
        });
        return {
          ...(await this.aggregate(tx, recipeId)),
          myRating: rating?.value ?? null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /** Caller identity comes from the guard. null removes the caller's score. */
  async set(
    recipeId: string,
    userId: string,
    value: number | null,
  ): Promise<MyRecipeRatingDto> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Account -> recipe lock order. Account updates/deletion cannot race
          // verification, and concurrent scores on a recipe settle sequentially.
          const [actor] = await tx.$queryRaw<
            { id: string; emailVerifiedAt: Date | null }[]
          >`
          SELECT id, email_verified_at AS "emailVerifiedAt"
          FROM users WHERE id = ${userId}::uuid FOR SHARE
        `;
          if (!actor)
            throw new UnauthorizedException('Account no longer exists');
          if (value !== null && !actor.emailVerifiedAt) {
            throw new ForbiddenException({
              code: 'EMAIL_NOT_VERIFIED',
              message: 'Verify your email before rating a recipe',
            });
          }

          const [recipe] = await tx.$queryRaw<
            { id: string; createdById: string | null }[]
          >`
          SELECT id, created_by_id AS "createdById"
          FROM recipes WHERE id = ${recipeId}::uuid FOR UPDATE
        `;
          if (!recipe) throw new NotFoundException('Recipe not found');
          if (value !== null && recipe.createdById === userId) {
            throw new ForbiddenException({
              code: 'SELF_RATING_NOT_ALLOWED',
              message: 'You cannot rate your own recipe',
            });
          }

          if (value === null) {
            await tx.recipeRating.deleteMany({ where: { recipeId, userId } });
          } else {
            await tx.recipeRating.upsert({
              where: { recipeId_userId: { recipeId, userId } },
              create: { recipeId, userId, value },
              update: { value },
            });
          }
          return { ...(await this.aggregate(tx, recipeId)), myRating: value };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2003', 'P2034'].includes(error.code)
      ) {
        throw new ConflictException({
          code: 'RATING_CONFLICT',
          message: 'The recipe or rating changed; reload before retrying',
        });
      }
      throw error;
    }
  }

  private async requireRecipe(tx: Prisma.TransactionClient, recipeId: string) {
    const recipe = await tx.recipe.findUnique({
      where: { id: recipeId },
      select: { id: true },
    });
    if (!recipe) throw new NotFoundException('Recipe not found');
  }

  private async aggregate(
    tx: Prisma.TransactionClient,
    recipeId: string,
  ): Promise<RecipeRatingSummaryDto> {
    // No stored aggregate to drift under retries/account deletion. Until the
    // account lifecycle feature exists, verified email is the eligibility gate.
    const stats = await tx.recipeRating.aggregate({
      where: { recipeId, user: { emailVerifiedAt: { not: null } } },
      _count: { value: true },
      _sum: { value: true },
    });
    const ratingCount = stats._count.value;
    return {
      recipeId,
      ratingCount,
      averageRating:
        ratingCount === 0
          ? null
          : Math.round((stats._sum.value! * 10) / ratingCount) / 10,
    };
  }
}
