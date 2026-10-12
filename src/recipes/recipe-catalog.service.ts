import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PostStatus, Prisma } from '@prisma/client';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import {
  CatalogRecipeDetailDto,
  CatalogRecipeDto,
  RecipeCatalogQueryDto,
} from './dto/recipe-catalog.dto';
import { IncompatibilityRulesService } from './incompatibility-rules.service';
import { catalogWhere } from './recipe-catalog.query';
import {
  recipeDetailInclude,
  recipeInclude,
  toRecipeDetailDto,
  toRecipeDto,
} from './recipes.service';
import { DietaryService } from './dietary.service';

@Injectable()
export class RecipeCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: IncompatibilityRulesService,
    private readonly dietary: DietaryService,
  ) {}

  async list(
    query: RecipeCatalogQueryDto,
    userId?: string,
  ): Promise<PaginatedResponseDto<CatalogRecipeDto>> {
    if (query.suitableForMe && !userId) {
      throw new UnauthorizedException(
        'Sign in to filter by your dietary profile',
      );
    }
    const where = catalogWhere(query, userId);
    const { skip, take } = getPaginationArgs(query);
    return this.prisma.$transaction(
      async (tx) => {
        if (query.suitableForMe)
          await this.dietary.assertReady(userId!, tx);
        const [ids, [count]] = await Promise.all([
          tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT r.id FROM recipes r ${where}
          ORDER BY r.updated_at DESC, r.id DESC LIMIT ${take} OFFSET ${skip}
        `),
          tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
          SELECT COUNT(*) AS total FROM recipes r ${where}
        `),
        ]);
        const rows =
          ids.length > 0
            ? await tx.recipe.findMany({
                where: { id: { in: ids.map(({ id }) => id) } },
                include: recipeInclude,
              })
            : [];
        const byId = new Map(rows.map((row) => [row.id, row]));
        const ordered = ids.map(({ id }) => byId.get(id)!);
        const conflicts = await this.rules.findConflictsForEach(
          ordered.map((row) =>
            row.ingredients.map(({ ingredientId }) => ingredientId),
          ),
          tx,
        );
        return createPaginatedResponse(
          ordered.map((row, index) => {
            const recipe = toRecipeDto(row, conflicts[index]);
            return {
              ...recipe,
              // Admin-authored recipes are public, but their source post may not be.
              post:
                row.post?.status === PostStatus.PUBLISHED ? recipe.post : null,
              totalMinutes: totalMinutes(row),
            };
          }),
          Number(count.total),
          query,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async findOne(id: string): Promise<CatalogRecipeDetailDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const row = await tx.recipe.findUnique({
          where: { id },
          include: recipeDetailInclude,
        });
        if (
          !row ||
          row.ingredients.length === 0 ||
          row.ingredients.some(
            (item) => item.ingredient.vegetarianStatus !== 'ALLOWED',
          )
        )
          throw new NotFoundException('Recipe not found');
        const [conflicts] = await this.rules.findConflictsForEach(
          [row.ingredients.map(({ ingredientId }) => ingredientId)],
          tx,
        );
        const detail = toRecipeDetailDto(row, conflicts);
        return {
          ...detail,
          post: row.post?.status === PostStatus.PUBLISHED ? detail.post : null,
          totalMinutes: totalMinutes(row),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

function totalMinutes(recipe: {
  prepMinutes: number | null;
  cookMinutes: number | null;
}): number | null {
  return recipe.prepMinutes === null && recipe.cookMinutes === null
    ? null
    : (recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0);
}
