import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import {
  IngredientDto,
  IngredientGroupDto,
  SaveIngredientDto,
  SaveIngredientGroupDto,
} from './dto/ingredient.dto';
import { badRequest, conflict, isPrismaError } from './recipe-errors';

const ingredientInclude = {
  groups: {
    select: { group: { select: { id: true, name: true } } },
    orderBy: { group: { name: 'asc' } },
  },
  _count: { select: { recipes: true } },
} satisfies Prisma.IngredientInclude;

type IngredientRow = Prisma.IngredientGetPayload<{
  include: typeof ingredientInclude;
}>;

const groupInclude = {
  members: {
    select: { ingredient: { select: { id: true, name: true } } },
    orderBy: { ingredient: { name: 'asc' } },
  },
} satisfies Prisma.IngredientGroupInclude;

type GroupRow = Prisma.IngredientGroupGetPayload<{
  include: typeof groupInclude;
}>;

/** The ingredient catalog and the groups that share incompatibility rules. */
@Injectable()
export class IngredientsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<IngredientDto>> {
    const [rows, totalItems] = await this.prisma.$transaction([
      this.prisma.ingredient.findMany({
        include: ingredientInclude,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        ...getPaginationArgs(query),
      }),
      this.prisma.ingredient.count(),
    ]);
    return createPaginatedResponse(rows.map(toIngredient), totalItems, query);
  }

  async create(dto: SaveIngredientDto): Promise<IngredientDto> {
    try {
      const row = await this.prisma.ingredient.create({
        data: {
          name: dto.name,
          aliases: dto.aliases ?? [],
          groups: {
            create: (dto.groupIds ?? []).map((groupId) => ({ groupId })),
          },
        },
        include: ingredientInclude,
      });
      return toIngredient(row);
    } catch (error: unknown) {
      throw translate(error, 'Ingredient') ?? error;
    }
  }

  async update(id: string, dto: SaveIngredientDto): Promise<IngredientDto> {
    try {
      const row = await this.prisma.ingredient.update({
        where: { id },
        data: {
          name: dto.name,
          aliases: dto.aliases ?? [],
          groups: {
            deleteMany: {},
            create: (dto.groupIds ?? []).map((groupId) => ({ groupId })),
          },
        },
        include: ingredientInclude,
      });
      return toIngredient(row);
    } catch (error: unknown) {
      throw translate(error, 'Ingredient') ?? error;
    }
  }

  /** Refused while a recipe still uses the ingredient. */
  async remove(id: string): Promise<void> {
    try {
      await this.prisma.ingredient.delete({ where: { id } });
    } catch (error: unknown) {
      if (isPrismaError(error, 'P2003')) {
        throw conflict(
          'INGREDIENT_IN_USE',
          'Remove the ingredient from its recipes first',
        );
      }
      throw translate(error, 'Ingredient') ?? error;
    }
  }

  async findAllGroups(
    query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<IngredientGroupDto>> {
    const [rows, totalItems] = await this.prisma.$transaction([
      this.prisma.ingredientGroup.findMany({
        include: groupInclude,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        ...getPaginationArgs(query),
      }),
      this.prisma.ingredientGroup.count(),
    ]);
    return createPaginatedResponse(rows.map(toGroup), totalItems, query);
  }

  async createGroup(dto: SaveIngredientGroupDto): Promise<IngredientGroupDto> {
    try {
      const row = await this.prisma.ingredientGroup.create({
        data: {
          name: dto.name,
          description: dto.description || null,
          dietary: dto.dietary ?? false,
          members: {
            create: (dto.ingredientIds ?? []).map((ingredientId) => ({
              ingredientId,
            })),
          },
        },
        include: groupInclude,
      });
      return toGroup(row);
    } catch (error: unknown) {
      throw translate(error, 'Ingredient group') ?? error;
    }
  }

  async updateGroup(
    id: string,
    dto: SaveIngredientGroupDto,
  ): Promise<IngredientGroupDto> {
    try {
      const row = await this.prisma.ingredientGroup.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description || null,
          dietary: dto.dietary ?? false,
          members: {
            deleteMany: {},
            create: (dto.ingredientIds ?? []).map((ingredientId) => ({
              ingredientId,
            })),
          },
        },
        include: groupInclude,
      });
      return toGroup(row);
    } catch (error: unknown) {
      throw translate(error, 'Ingredient group') ?? error;
    }
  }

  /** Also deletes the rules that name the group. */
  async removeGroup(id: string): Promise<void> {
    try {
      await this.prisma.ingredientGroup.delete({ where: { id } });
    } catch (error: unknown) {
      throw translate(error, 'Ingredient group') ?? error;
    }
  }
}

function translate(error: unknown, subject: string): Error | undefined {
  if (isPrismaError(error, 'P2002')) {
    return conflict('NAME_TAKEN', `${subject} name is already used`);
  }
  if (isPrismaError(error, 'P2003')) {
    return badRequest(
      'UNKNOWN_REFERENCE',
      'An id in the request does not exist',
    );
  }
  if (isPrismaError(error, 'P2025')) {
    return new NotFoundException(`${subject} not found`);
  }
  return undefined;
}

function toIngredient(row: IngredientRow): IngredientDto {
  return {
    id: row.id,
    name: row.name,
    aliases: row.aliases,
    groups: row.groups.map(({ group }) => group),
    recipeCount: row._count.recipes,
    createdAt: row.createdAt,
  };
}

function toGroup(row: GroupRow): IngredientGroupDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    dietary: row.dietary,
    ingredients: row.members.map(({ ingredient }) => ingredient),
    createdAt: row.createdAt,
  };
}
