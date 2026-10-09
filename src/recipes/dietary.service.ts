import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DietaryOptionsDto,
  DietaryRestrictionsDto,
  SaveDietaryRestrictionsDto,
} from './dto/dietary.dto';
import { badRequest, isPrismaError } from './recipe-errors';

const named = { select: { id: true, name: true } } as const;

/** What a user does not eat (ingredients and whole groups) and the ingredients they like. Never shown to others. */
@Injectable()
export class DietaryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every ingredient, and the groups admins marked as food categories. */
  async options(): Promise<DietaryOptionsDto> {
    const [ingredients, groups] = await Promise.all([
      this.prisma.ingredient.findMany({
        select: { id: true, name: true, aliases: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.ingredientGroup.findMany({
        where: { dietary: true },
        select: {
          id: true,
          name: true,
          members: {
            select: { ingredient: { select: { name: true } } },
            orderBy: { ingredient: { name: 'asc' } },
          },
        },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      ingredients,
      groups: groups.map(({ members, ...group }) => ({
        ...group,
        ingredients: members.map(({ ingredient }) => ingredient.name),
      })),
    };
  }

  async find(userId: string): Promise<DietaryRestrictionsDto> {
    const [ingredients, groups, liked] = await Promise.all([
      this.prisma.userAvoidedIngredient.findMany({
        where: { userId },
        select: { ingredient: named },
        orderBy: { ingredient: { name: 'asc' } },
      }),
      this.prisma.userAvoidedGroup.findMany({
        where: { userId },
        select: { group: named },
        orderBy: { group: { name: 'asc' } },
      }),
      this.prisma.userLikedIngredient.findMany({
        where: { userId },
        select: { ingredient: named },
        orderBy: { ingredient: { name: 'asc' } },
      }),
    ]);
    return {
      ingredients: ingredients.map(({ ingredient }) => ingredient),
      groups: groups.map(({ group }) => group),
      liked: liked.map(({ ingredient }) => ingredient),
    };
  }

  /** Every ingredient the user avoids, directly or through a group. */
  async avoidedIngredientIds(userId: string): Promise<Set<string>> {
    const [direct, viaGroups] = await Promise.all([
      this.prisma.userAvoidedIngredient.findMany({
        where: { userId },
        select: { ingredientId: true },
      }),
      this.prisma.ingredientGroupMember.findMany({
        where: { group: { avoidedBy: { some: { userId } } } },
        select: { ingredientId: true },
      }),
    ]);
    return new Set(
      [...direct, ...viaGroups].map(({ ingredientId }) => ingredientId),
    );
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
    try {
      await this.prisma.$transaction([
        this.prisma.userAvoidedIngredient.deleteMany({ where: { userId } }),
        this.prisma.userAvoidedGroup.deleteMany({ where: { userId } }),
        this.prisma.userLikedIngredient.deleteMany({ where: { userId } }),
        this.prisma.userAvoidedIngredient.createMany({
          data: dto.ingredientIds.map((ingredientId) => ({
            userId,
            ingredientId,
          })),
        }),
        this.prisma.userAvoidedGroup.createMany({
          data: dto.groupIds.map((groupId) => ({ userId, groupId })),
        }),
        this.prisma.userLikedIngredient.createMany({
          data: dto.likedIngredientIds.map((ingredientId) => ({
            userId,
            ingredientId,
          })),
        }),
      ]);
    } catch (error: unknown) {
      if (isPrismaError(error, 'P2003')) {
        throw badRequest(
          'UNKNOWN_REFERENCE',
          'An ingredient or group in the request does not exist',
        );
      }
      throw error;
    }
    return this.find(userId);
  }
}
