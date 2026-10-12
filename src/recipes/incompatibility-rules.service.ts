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
  type ConflictRule,
  detectConflicts,
  type IngredientConflict,
} from './conflicts';
import {
  IncompatibilityRuleDto,
  RuleSideDto,
  RuleSideInputDto,
  SaveIncompatibilityRuleDto,
} from './dto/ingredient.dto';
import { RecipeConflictDto } from './dto/recipe.dto';
import { badRequest, conflict, isPrismaError } from './recipe-errors';

const named = { select: { id: true, name: true } } as const;

const ruleInclude = {
  aIngredient: named,
  aGroup: named,
  bIngredient: named,
  bGroup: named,
} satisfies Prisma.IncompatibilityRuleInclude;

type RuleRow = Prisma.IncompatibilityRuleGetPayload<{
  include: typeof ruleInclude;
}>;

type Side = { ingredientId: string | null; groupId: string | null };

const toSide = ({ kind, id }: RuleSideInputDto): Side =>
  kind === 'INGREDIENT'
    ? { ingredientId: id, groupId: null }
    : { ingredientId: null, groupId: id };

/** "A should not be eaten with B" rules, and the conflicts they cause. */
@Injectable()
export class IncompatibilityRulesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<IncompatibilityRuleDto>> {
    const [rows, totalItems] = await this.prisma.$transaction([
      this.prisma.incompatibilityRule.findMany({
        include: ruleInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...getPaginationArgs(query),
      }),
      this.prisma.incompatibilityRule.count(),
    ]);
    return createPaginatedResponse(rows.map(toDto), totalItems, query);
  }

  async create(
    dto: SaveIncompatibilityRuleDto,
  ): Promise<IncompatibilityRuleDto> {
    const data = await this.toData(dto);
    try {
      const row = await this.prisma.incompatibilityRule.create({
        data,
        include: ruleInclude,
      });
      return toDto(row);
    } catch (error: unknown) {
      throw translate(error) ?? error;
    }
  }

  async update(
    id: string,
    dto: SaveIncompatibilityRuleDto,
  ): Promise<IncompatibilityRuleDto> {
    const data = await this.toData(dto, id);
    try {
      const row = await this.prisma.incompatibilityRule.update({
        where: { id },
        data,
        include: ruleInclude,
      });
      return toDto(row);
    } catch (error: unknown) {
      throw translate(error) ?? error;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.prisma.incompatibilityRule.delete({ where: { id } });
    } catch (error: unknown) {
      throw translate(error) ?? error;
    }
  }

  /** The forbidden pairs in one set of ingredients, with their names. */
  async findConflicts(ingredientIds: string[]): Promise<RecipeConflictDto[]> {
    const [conflicts] = await this.findConflictsForEach([ingredientIds]);
    if (conflicts.length === 0) return [];
    const ingredients = await this.prisma.ingredient.findMany({
      where: { id: { in: ingredientIds } },
      select: { id: true, name: true },
    });
    const byId = new Map(ingredients.map((item) => [item.id, item]));
    return conflicts.flatMap(({ ingredientAId, ingredientBId, ...rest }) => {
      const a = byId.get(ingredientAId);
      const b = byId.get(ingredientBId);
      return a && b ? [{ ...rest, a, b }] : [];
    });
  }

  /** Conflicts of several ingredient sets, reading groups and rules once. */
  async findConflictsForEach(
    ingredientSets: string[][],
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<IngredientConflict[][]> {
    const ingredientIds = [...new Set(ingredientSets.flat())];
    if (ingredientIds.length < 2) return ingredientSets.map(() => []);

    const memberships = await db.ingredientGroupMember.findMany({
      where: { ingredientId: { in: ingredientIds } },
    });
    const groupsByIngredient = new Map<string, Set<string>>();
    for (const { ingredientId, groupId } of memberships) {
      const groups = groupsByIngredient.get(ingredientId) ?? new Set();
      groups.add(groupId);
      groupsByIngredient.set(ingredientId, groups);
    }
    const groupIds = [...new Set(memberships.map(({ groupId }) => groupId))];

    const rules: ConflictRule[] = await db.incompatibilityRule.findMany({
      where: {
        AND: [
          {
            OR: [
              { aIngredientId: { in: ingredientIds } },
              { aGroupId: { in: groupIds } },
            ],
          },
          {
            OR: [
              { bIngredientId: { in: ingredientIds } },
              { bGroupId: { in: groupIds } },
            ],
          },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return ingredientSets.map((ids) =>
      detectConflicts(ids, groupsByIngredient, rules),
    );
  }

  private async toData(dto: SaveIncompatibilityRuleDto, selfId?: string) {
    const a = toSide(dto.a);
    const b = toSide(dto.b);
    if (a.ingredientId && a.ingredientId === b.ingredientId) {
      throw badRequest(
        'SAME_INGREDIENT',
        'An ingredient cannot be incompatible with itself',
      );
    }
    const pair = (first: Side, second: Side) => ({
      aIngredientId: first.ingredientId,
      aGroupId: first.groupId,
      bIngredientId: second.ingredientId,
      bGroupId: second.groupId,
    });
    const duplicate = await this.prisma.incompatibilityRule.findFirst({
      where: {
        OR: [pair(a, b), pair(b, a)],
        ...(selfId ? { id: { not: selfId } } : {}),
      },
      select: { id: true },
    });
    if (duplicate) {
      throw conflict('RULE_EXISTS', 'A rule for this pair already exists');
    }
    return {
      ...pair(a, b),
      reason: dto.reason,
      source: dto.source || null,
    };
  }
}

function translate(error: unknown): Error | undefined {
  if (isPrismaError(error, 'P2003')) {
    return badRequest(
      'UNKNOWN_REFERENCE',
      'An id in the request does not exist',
    );
  }
  if (isPrismaError(error, 'P2025')) {
    return new NotFoundException('Rule not found');
  }
  return undefined;
}

function toSideDto(
  ingredient: { id: string; name: string } | null,
  group: { id: string; name: string } | null,
): RuleSideDto {
  if (ingredient) return { kind: 'INGREDIENT', ...ingredient };
  if (group) return { kind: 'GROUP', ...group };
  throw new Error('Incompatibility rule with an empty side');
}

function toDto(row: RuleRow): IncompatibilityRuleDto {
  return {
    id: row.id,
    a: toSideDto(row.aIngredient, row.aGroup),
    b: toSideDto(row.bIngredient, row.bGroup),
    reason: row.reason,
    source: row.source,
    createdAt: row.createdAt,
  };
}
