import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PostStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination';
import {
  FavoriteRecipeDto,
  RecipeFavoriteStateDto,
} from './dto/recipe-favorite.dto';
import { IncompatibilityRulesService } from './incompatibility-rules.service';
import { recipeInclude, toRecipeDto } from './recipes.service';
import { totalMinutes } from './recipe-catalog.service';

@Injectable()
export class RecipeFavoritesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: IncompatibilityRulesService,
  ) {}

  async list(
    userId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<FavoriteRecipeDto>> {
    return this.prisma.$transaction(
      async (tx) => {
        const where = { userId };
        const rows = await tx.recipeFavorite.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { recipeId: 'desc' }],
          ...getPaginationArgs(query),
          include: { recipe: { include: recipeInclude } },
        });
        const count = await tx.recipeFavorite.count({ where });
        const conflicts = await this.rules.findConflictsForEach(
          rows.map(({ recipe }) =>
            recipe.ingredients.map(({ ingredientId }) => ingredientId),
          ),
          tx,
        );
        return createPaginatedResponse(
          rows.map(({ recipe, createdAt }, index) => ({
            ...toRecipeDto(recipe, conflicts[index]),
            post:
              recipe.post?.status === PostStatus.PUBLISHED
                ? { id: recipe.post.id, author: recipe.post.author }
                : null,
            totalMinutes: totalMinutes(recipe),
            isFavorite: true,
            savedAt: createdAt,
          })),
          count,
          query,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async set(
    recipeId: string,
    userId: string,
    isFavorite: boolean,
  ): Promise<RecipeFavoriteStateDto> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const users = await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM users WHERE id = ${userId}::uuid FOR SHARE`;
          if (!users.length)
            throw new UnauthorizedException('Account no longer exists');
          const recipes = await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM recipes WHERE id = ${recipeId}::uuid FOR UPDATE`;
          if (!recipes.length) throw new NotFoundException('Recipe not found');
          if (isFavorite) {
            // Duplicate retries preserve the original savedAt and ordering.
            await tx.recipeFavorite.createMany({
              data: [{ recipeId, userId }],
              skipDuplicates: true,
            });
          } else {
            await tx.recipeFavorite.deleteMany({ where: { recipeId, userId } });
          }
          return { recipeId, isFavorite };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2003', 'P2034'].includes(error.code)
      ) {
        throw new ConflictException({
          code: 'FAVORITE_CONFLICT',
          message: 'The recipe or saved state changed; reload before retrying',
        });
      }
      throw error;
    }
  }
}
