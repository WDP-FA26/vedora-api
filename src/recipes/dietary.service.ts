import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AllergyAcknowledgement,
  AllergenLabel,
  AnimalLabel,
  DietMode,
  DietaryLabelKind,
  ExclusionReason,
  Prisma,
} from '@prisma/client';
import { isUUID } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import {
  DietaryExclusionDto,
  DietaryOptionsDto,
  DietaryRestrictionsDto,
  PatchDietaryProfileDto,
  MAX_MANUAL_EXCLUSIONS,
  SaveDietaryRestrictionsDto,
} from './dto/dietary.dto';
import { DietarySafetyContext, VEGAN_ANIMAL_LABELS } from './dietary-safety';
import { badRequest, conflict, isPrismaError } from './recipe-errors';

const named = { select: { id: true, name: true } } as const;
const profileSelect = {
  dietMode: true,
  allergyAcknowledgement: true,
  dietaryVersion: true,
  dietaryUpdatedAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class DietaryService {
  constructor(private readonly prisma: PrismaService) {}

  async options(): Promise<DietaryOptionsDto> {
    const [ingredients, groups] = await this.prisma.$transaction([
      this.prisma.ingredient.findMany({
        where: { active: true },
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
      animalLabels: Object.values(AnimalLabel),
      allergenLabels: Object.values(AllergenLabel),
      groups: groups.map(({ members, ...group }) => ({
        ...group,
        ingredients: members.map(({ ingredient }) => ingredient.name),
      })),
    };
  }

  async find(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<DietaryRestrictionsDto> {
    if (!tx)
      return this.prisma.$transaction((db) => this.find(userId, db), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    const [user, ingredients, groups, labels, liked] = await Promise.all([
      tx.user.findUnique({ where: { id: userId }, select: profileSelect }),
      tx.userAvoidedIngredient.findMany({
        where: { userId },
        select: { ingredientId: true, reason: true, ingredient: named },
        orderBy: { ingredient: { name: 'asc' } },
      }),
      tx.userAvoidedGroup.findMany({
        where: { userId },
        select: { groupId: true, reason: true, group: named },
        orderBy: { group: { name: 'asc' } },
      }),
      tx.userAvoidedLabel.findMany({
        where: { userId },
        orderBy: [{ kind: 'asc' }, { label: 'asc' }, { reason: 'asc' }],
      }),
      tx.userLikedIngredient.findMany({
        where: { userId },
        select: { ingredient: named },
        orderBy: { ingredient: { name: 'asc' } },
      }),
    ]);
    if (!user) throw new NotFoundException('Dietary profile not found');
    const exclusions = mergeExclusions([
      ...ingredients.map((row) => ({
        kind: 'INGREDIENT' as const,
        target: row.ingredientId,
        reasons: [row.reason],
      })),
      ...groups.map((row) => ({
        kind: 'GROUP' as const,
        target: row.groupId,
        reasons: [row.reason],
      })),
      ...labels.map((row) => ({
        kind: row.kind,
        target: row.label,
        reasons: [row.reason],
      })),
      ...(user.dietMode === DietMode.VEGAN
        ? VEGAN_ANIMAL_LABELS.map((label) => ({
            kind: 'ANIMAL' as const,
            target: label,
            reasons: [ExclusionReason.DIET],
          }))
        : []),
    ]);
    const hasAllergy = exclusions.some((row) =>
      row.reasons.includes(ExclusionReason.ALLERGY),
    );
    return {
      dietMode: user.dietMode,
      allergyAcknowledgement: user.allergyAcknowledgement,
      version: user.dietaryVersion,
      updatedAt: user.dietaryUpdatedAt,
      readyForMealPlanning:
        (user.allergyAcknowledgement === AllergyAcknowledgement.NONE_DECLARED &&
          !hasAllergy) ||
        (user.allergyAcknowledgement === AllergyAcknowledgement.DECLARED &&
          hasAllergy),
      exclusions,
      ingredients: uniqueNamed(ingredients.map((row) => row.ingredient)),
      groups: uniqueNamed(groups.map((row) => row.group)),
      liked: liked.map((row) => row.ingredient),
    };
  }

  async context(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<DietarySafetyContext> {
    if (!tx)
      return this.prisma.$transaction((db) => this.context(userId, db), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    const db = tx;
    const profile = await this.find(userId, tx);
    const groupIds = profile.exclusions
      .filter((row) => row.kind === 'GROUP')
      .map((row) => row.target);
    const members = groupIds.length
      ? await db.ingredientGroupMember.findMany({
          where: { groupId: { in: groupIds } },
          select: { ingredientId: true },
        })
      : [];
    return {
      dietMode: profile.dietMode,
      allergyAcknowledgement: profile.allergyAcknowledgement,
      hasAllergy: profile.exclusions.some((row) =>
        row.reasons.includes(ExclusionReason.ALLERGY),
      ),
      avoidedIds: new Set([
        ...profile.exclusions
          .filter((row) => row.kind === 'INGREDIENT')
          .map((row) => row.target),
        ...members.map((row) => row.ingredientId),
      ]),
      animalLabels: profile.exclusions
        .filter((row) => row.kind === 'ANIMAL')
        .map((row) => row.target),
      allergenLabels: profile.exclusions
        .filter((row) => row.kind === 'ALLERGEN')
        .map((row) => row.target),
    };
  }

  async assertReady(
    userId: string,
    tx?: Prisma.TransactionClient,
    expectedVersion?: number,
  ): Promise<DietaryRestrictionsDto> {
    const profile = await this.find(userId, tx);
    if (expectedVersion !== undefined && expectedVersion !== profile.version)
      throw conflict(
        'DIETARY_PROFILE_CHANGED',
        'Your dietary profile changed; generate a new proposal',
      );
    if (!profile.readyForMealPlanning)
      throw conflict(
        'DIETARY_PROFILE_INCOMPLETE',
        'Confirm your allergy information before planning meals',
      );
    return profile;
  }

  async avoidedIngredientIds(userId: string): Promise<Set<string>> {
    return (await this.context(userId)).avoidedIds;
  }

  async replace(
    userId: string,
    dto: SaveDietaryRestrictionsDto,
  ): Promise<DietaryRestrictionsDto> {
    // Legacy clients control PERSONAL rows, never remove an existing allergy.
    return this.mutate(userId, dto.expectedVersion, (current) => ({
      expectedVersion: dto.expectedVersion,
      exclusions: mergeExclusions([
        ...current.exclusions
          .map((row) => ({
            ...row,
            reasons: row.reasons.filter(
              (reason) => reason !== ExclusionReason.PERSONAL,
            ),
          }))
          .filter((row) => row.reasons.length),
        ...dto.ingredientIds.map((target) => ({
          kind: 'INGREDIENT' as const,
          target,
          reasons: [ExclusionReason.PERSONAL],
        })),
        ...dto.groupIds.map((target) => ({
          kind: 'GROUP' as const,
          target,
          reasons: [ExclusionReason.PERSONAL],
        })),
      ]),
      likedIngredientIds: dto.likedIngredientIds,
    }));
  }

  async patch(
    userId: string,
    dto: PatchDietaryProfileDto,
  ): Promise<DietaryRestrictionsDto> {
    if (Object.keys(dto).every((key) => key === 'expectedVersion'))
      throw badRequest('EMPTY_UPDATE', 'Provide a profile field to update');
    return this.mutate(userId, dto.expectedVersion, () => dto);
  }

  private async mutate(
    userId: string,
    expectedVersion: number,
    input: (profile: DietaryRestrictionsDto) => PatchDietaryProfileDto,
  ): Promise<DietaryRestrictionsDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        const current = await this.find(userId, tx);
        if (current.version !== expectedVersion)
          throw conflict(
            'VERSION_CONFLICT',
            'Reload your dietary profile before saving',
          );
        const dto = input(current);
        const dietMode = dto.dietMode ?? current.dietMode;
        const acknowledgement =
          dto.allergyAcknowledgement ?? current.allergyAcknowledgement;
        let exclusions = dto.exclusions ?? current.exclusions;
        exclusions = exclusions
          .map((row) => ({
            ...row,
            reasons: row.reasons.filter(
              (reason) =>
                !(row.kind === 'ANIMAL' && reason === ExclusionReason.DIET) &&
                !(
                  dietMode === DietMode.VEGETARIAN &&
                  dto.dietMode !== undefined &&
                  reason === ExclusionReason.DIET
                ),
            ),
          }))
          .filter((row) => row.reasons.length);
        if (exclusions.length > MAX_MANUAL_EXCLUSIONS)
          throw badRequest(
            'TOO_MANY_EXCLUSIONS',
            'At most 300 manual exclusion targets are supported',
          );
        if (dietMode === DietMode.VEGAN)
          exclusions = mergeExclusions([
            ...exclusions,
            ...VEGAN_ANIMAL_LABELS.map((target) => ({
              kind: 'ANIMAL' as const,
              target,
              reasons: [ExclusionReason.DIET],
            })),
          ]);
        exclusions = mergeExclusions(
          exclusions.map((row) => ({
            ...row,
            target:
              row.kind === 'INGREDIENT' || row.kind === 'GROUP'
                ? row.target.toLowerCase()
                : row.target,
          })),
        );
        validateTargets(exclusions);
        const hasAllergy = exclusions.some((row) =>
          row.reasons.includes(ExclusionReason.ALLERGY),
        );
        if (
          (acknowledgement === AllergyAcknowledgement.NONE_DECLARED &&
            hasAllergy) ||
          (acknowledgement === AllergyAcknowledgement.DECLARED && !hasAllergy)
        )
          throw badRequest(
            'INVALID_ALLERGY_ACKNOWLEDGEMENT',
            'DECLARED requires at least one ALLERGY exclusion; NONE_DECLARED requires none',
          );
        const liked = [
          ...new Set(
            (dto.likedIngredientIds ?? current.liked.map((row) => row.id)).map(
              (id) => id.toLowerCase(),
            ),
          ),
        ];
        const groupIds = exclusions
          .filter((row) => row.kind === 'GROUP')
          .map((row) => row.target);
        const ingredientIds = exclusions
          .filter((row) => row.kind === 'INGREDIENT')
          .map((row) => row.target);
        const [ingredients, groups, members] = await Promise.all([
          tx.ingredient.findMany({
            where: { id: { in: [...new Set([...liked, ...ingredientIds])] } },
            select: {
              id: true,
              animalLabels: true,
              allergenLabels: true,
              mayContainAllergens: true,
            },
          }),
          tx.ingredientGroup.findMany({
            where: { id: { in: [...new Set(groupIds)] } },
            select: { id: true },
          }),
          tx.ingredientGroupMember.findMany({
            where: { groupId: { in: groupIds } },
            select: { ingredientId: true },
          }),
        ]);
        if (
          ingredients.length !== new Set([...liked, ...ingredientIds]).size ||
          groups.length !== new Set(groupIds).size
        )
          throw badRequest(
            'UNKNOWN_REFERENCE',
            'An ingredient or group does not exist',
          );
        const avoided = new Set([
          ...ingredientIds,
          ...members.map((row) => row.ingredientId),
        ]);
        const animals = exclusions
          .filter((row) => row.kind === 'ANIMAL')
          .map((row) => row.target);
        const allergens = exclusions
          .filter((row) => row.kind === 'ALLERGEN')
          .map((row) => row.target);
        if (
          liked.some(
            (id) =>
              avoided.has(id) ||
              ingredients.some(
                (item) =>
                  item.id === id &&
                  (item.animalLabels.some((label) => animals.includes(label)) ||
                    [...item.allergenLabels, ...item.mayContainAllergens].some(
                      (label) => allergens.includes(label),
                    )),
              ),
          )
        )
          throw badRequest(
            'CONFLICTING_PREFERENCE',
            'An ingredient cannot be both liked and excluded',
          );
        await tx.userAvoidedIngredient.deleteMany({ where: { userId } });
        await tx.userAvoidedGroup.deleteMany({ where: { userId } });
        await tx.userAvoidedLabel.deleteMany({ where: { userId } });
        await tx.userLikedIngredient.deleteMany({ where: { userId } });
        await tx.userAvoidedIngredient.createMany({
          data: exclusions
            .filter((row) => row.kind === 'INGREDIENT')
            .flatMap((row) =>
              row.reasons.map((reason) => ({
                userId,
                ingredientId: row.target,
                reason,
              })),
            ),
        });
        await tx.userAvoidedGroup.createMany({
          data: exclusions
            .filter((row) => row.kind === 'GROUP')
            .flatMap((row) =>
              row.reasons.map((reason) => ({
                userId,
                groupId: row.target,
                reason,
              })),
            ),
        });
        await tx.userAvoidedLabel.createMany({
          data: exclusions
            .filter((row) => row.kind === 'ANIMAL' || row.kind === 'ALLERGEN')
            .flatMap((row) =>
              row.reasons.map((reason) => ({
                userId,
                kind: row.kind as DietaryLabelKind,
                label: row.target,
                reason,
              })),
            ),
        });
        await tx.userLikedIngredient.createMany({
          data: liked.map((ingredientId) => ({ userId, ingredientId })),
        });
        await tx.user.update({
          where: { id: userId },
          data: {
            dietMode,
            allergyAcknowledgement: acknowledgement,
            dietaryVersion: { increment: 1 },
            dietaryUpdatedAt: new Date(),
          },
        });
        return this.find(userId, tx);
      });
    } catch (error) {
      if (isPrismaError(error, 'P2003'))
        throw badRequest(
          'UNKNOWN_REFERENCE',
          'An ingredient or group no longer exists',
        );
      throw error;
    }
  }
}

function mergeExclusions(rows: DietaryExclusionDto[]): DietaryExclusionDto[] {
  const byTarget = new Map<string, DietaryExclusionDto>();
  for (const row of rows) {
    const key = row.kind + ':' + row.target;
    const previous = byTarget.get(key);
    byTarget.set(key, {
      ...row,
      reasons: [
        ...new Set([...(previous?.reasons ?? []), ...row.reasons]),
      ].sort(),
    });
  }
  return [...byTarget.values()].sort((a, b) =>
    (a.kind + ':' + a.target).localeCompare(b.kind + ':' + b.target),
  );
}

function uniqueNamed(rows: { id: string; name: string }[]) {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function validateTargets(rows: DietaryExclusionDto[]) {
  for (const row of rows) {
    const valid =
      row.kind === 'INGREDIENT' || row.kind === 'GROUP'
        ? isUUID(row.target, '4')
        : row.kind === 'ANIMAL'
          ? Object.values(AnimalLabel).includes(row.target as AnimalLabel)
          : Object.values(AllergenLabel).includes(row.target as AllergenLabel);
    if (!valid)
      throw badRequest(
        'INVALID_EXCLUSION_TARGET',
        'Use a canonical UUID or supported label',
      );
    if (row.kind === 'ANIMAL' && row.reasons.includes(ExclusionReason.ALLERGY))
      throw badRequest(
        'INVALID_EXCLUSION_TARGET',
        'Use an allergen label, ingredient or group for an allergy',
      );
  }
}
