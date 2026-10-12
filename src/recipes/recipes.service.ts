import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type { IngredientConflict } from './conflicts';
import { RecipeDetailDto, RecipeDto, SaveRecipeDto } from './dto/recipe.dto';
import { IncompatibilityRulesService } from './incompatibility-rules.service';
import { badRequest, isPrismaError } from './recipe-errors';
import { ingredientSafetySelect } from './dietary-safety';

const post = {
  select: {
    id: true,
    status: true,
    author: { select: { username: true, fullName: true } },
  },
} satisfies Prisma.PostDefaultArgs;

export const recipeInclude = {
  post,
  ingredients: {
    select: {
      ingredientId: true,
      ingredient: { select: ingredientSafetySelect },
    },
  },
} satisfies Prisma.RecipeInclude;

export const recipeDetailInclude = {
  post,
  ingredients: {
    include: { ingredient: { select: ingredientSafetySelect } },
    orderBy: { position: 'asc' },
  },
} satisfies Prisma.RecipeInclude;

type RecipeRow = Prisma.RecipeGetPayload<{ include: typeof recipeInclude }>;

@Injectable()
export class RecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: IncompatibilityRulesService,
  ) {}

  async findAll(
    query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<RecipeDto>> {
    const [rows, totalItems] = await this.prisma.$transaction([
      this.prisma.recipe.findMany({
        include: recipeInclude,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        ...getPaginationArgs(query),
      }),
      this.prisma.recipe.count(),
    ]);
    const conflicts = await this.rules.findConflictsForEach(
      rows.map((row) => row.ingredients.map((item) => item.ingredientId)),
    );
    return createPaginatedResponse(
      rows.map((row, index) => toRecipeDto(row, conflicts[index])),
      totalItems,
      query,
    );
  }

  async findOne(id: string): Promise<RecipeDetailDto> {
    const row = await this.prisma.recipe.findUnique({
      where: { id },
      include: recipeDetailInclude,
    });
    if (!row) throw new NotFoundException('Recipe not found');
    const [conflicts] = await this.rules.findConflictsForEach([
      row.ingredients.map((item) => item.ingredientId),
    ]);
    return toRecipeDetailDto(row, conflicts);
  }

  async create(userId: string, dto: SaveRecipeDto): Promise<RecipeDetailDto> {
    try {
      const { id } = await this.prisma.recipe.create({
        data: {
          ...toData(dto),
          createdById: userId,
          ingredients: { create: toIngredientRows(dto) },
        },
        select: { id: true },
      });
      return await this.findOne(id);
    } catch (error: unknown) {
      throw translate(error) ?? error;
    }
  }

  async update(id: string, dto: SaveRecipeDto): Promise<RecipeDetailDto> {
    try {
      await this.prisma.recipe.update({
        where: { id },
        data: {
          ...toData(dto),
          ingredients: { deleteMany: {}, create: toIngredientRows(dto) },
        },
        select: { id: true },
      });
      return await this.findOne(id);
    } catch (error: unknown) {
      throw translate(error) ?? error;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.prisma.recipe.delete({ where: { id } });
    } catch (error: unknown) {
      throw translate(error) ?? error;
    }
  }
}

function toData(dto: SaveRecipeDto) {
  return {
    title: dto.title,
    description: dto.description || null,
    imageUrl: dto.imageUrl || null,
    servings: dto.servings,
    prepMinutes: dto.prepMinutes ?? null,
    cookMinutes: dto.cookMinutes ?? null,
    steps: dto.steps,
    postId: dto.postId ?? null,
  };
}

function toIngredientRows(dto: SaveRecipeDto) {
  return dto.ingredients.map((item, position) => ({
    ingredientId: item.ingredientId,
    position,
    quantity: item.quantity ?? null,
    unit: item.unit || null,
    note: item.note || null,
  }));
}

function translate(error: unknown): Error | undefined {
  if (isPrismaError(error, 'P2003')) {
    return badRequest(
      'UNKNOWN_REFERENCE',
      'An ingredient or the post in the request does not exist',
    );
  }
  if (isPrismaError(error, 'P2025')) {
    return new NotFoundException('Recipe not found');
  }
  return undefined;
}

export function toRecipeDto(
  row: RecipeRow,
  conflicts: IngredientConflict[],
): RecipeDto {
  const names = new Map(
    row.ingredients.map((item) => [item.ingredientId, item.ingredient.name]),
  );
  const named = (id: string) => ({ id, name: names.get(id) ?? '' });
  return {
    id: row.id,
    veganStatus: row.ingredients.some(
      (item) =>
        item.ingredient.veganStatus === 'NON_VEGAN' ||
        item.ingredient.animalLabels.length > 0,
    )
      ? 'NON_VEGAN'
      : row.ingredients.length > 0 &&
          row.ingredients.every(
            (item) =>
              item.ingredient.veganStatus === 'VEGAN' &&
              item.ingredient.vegetarianStatus === 'ALLOWED',
          )
        ? 'VERIFIED_VEGAN'
        : 'UNKNOWN',
    title: row.title,
    imageUrl: row.imageUrl,
    servings: row.servings,
    prepMinutes: row.prepMinutes,
    cookMinutes: row.cookMinutes,
    ingredientCount: row.ingredients.length,
    conflictCount: conflicts.length,
    conflicts: conflicts.map(({ ingredientAId, ingredientBId, ...rest }) => ({
      ...rest,
      a: named(ingredientAId),
      b: named(ingredientBId),
    })),
    post: row.post ? { id: row.post.id, author: row.post.author } : null,
    updatedAt: row.updatedAt,
  };
}

export function toRecipeDetailDto(
  row: Prisma.RecipeGetPayload<{ include: typeof recipeDetailInclude }>,
  conflicts: IngredientConflict[],
): RecipeDetailDto {
  return {
    ...toRecipeDto(row, conflicts),
    description: row.description,
    steps: row.steps,
    ingredients: row.ingredients.map((item) => ({
      ingredientId: item.ingredientId,
      name: item.ingredient.name,
      allergenLabels: item.ingredient.allergenLabels,
      mayContainAllergens: item.ingredient.mayContainAllergens,
      allergensComplete: item.ingredient.allergensComplete,
      compositionComplete: item.ingredient.compositionComplete,
      active: item.ingredient.active,
      safetyVersion: item.ingredient.safetyVersion,
      quantity: item.quantity?.toNumber() ?? null,
      unit: item.unit,
      note: item.note,
    })),
  };
}
