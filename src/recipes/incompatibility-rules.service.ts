import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { HydratedDocument, Model } from 'mongoose';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination';
import {
  Ingredient,
  IngredientGroup,
  IngredientGroupMember,
  IncompatibilityRule,
} from '../mongo/models';
import { allExist } from '../mongo/references';
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
import { badRequest, conflict } from './recipe-errors';

type Named = { id: string; name: string };

/** A rule with the ingredient or group named on each side. */
type RuleRow = IncompatibilityRule & {
  aIngredient: Named | null;
  aGroup: Named | null;
  bIngredient: Named | null;
  bGroup: Named | null;
};

type Side = { ingredientId: string | null; groupId: string | null };

const toSide = ({ kind, id }: RuleSideInputDto): Side =>
  kind === 'INGREDIENT'
    ? { ingredientId: id, groupId: null }
    : { ingredientId: null, groupId: id };

/** "A should not be eaten with B" rules, and the conflicts they cause. */
@Injectable()
export class IncompatibilityRulesService {
  constructor(
    @InjectModel(IncompatibilityRule.name)
    private readonly rules: Model<IncompatibilityRule>,
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
    @InjectModel(IngredientGroup.name)
    private readonly groups: Model<IngredientGroup>,
    @InjectModel(IngredientGroupMember.name)
    private readonly members: Model<IngredientGroupMember>,
  ) {}

  async findAll(
    query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<IncompatibilityRuleDto>> {
    const { skip, take } = getPaginationArgs(query);
    const [rows, totalItems] = await Promise.all([
      this.rules
        .find()
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(take)
        .exec(),
      this.rules.countDocuments(),
    ]);
    const withSides = await this.attachSides(rows);
    return createPaginatedResponse(withSides.map(toDto), totalItems, query);
  }

  async create(
    dto: SaveIncompatibilityRuleDto,
  ): Promise<IncompatibilityRuleDto> {
    const data = await this.toData(dto);
    const created = await this.rules.create(data);
    return this.findOne(created.id);
  }

  async update(
    id: string,
    dto: SaveIncompatibilityRuleDto,
  ): Promise<IncompatibilityRuleDto> {
    const data = await this.toData(dto, id);
    const updated = await this.rules
      .findOneAndUpdate(
        { _id: id },
        { $set: data },
        { returnDocument: 'after' },
      )
      .exec();
    if (!updated) throw new NotFoundException('Rule not found');
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    const removed = await this.rules.deleteOne({ _id: id }).exec();
    if (removed.deletedCount === 0)
      throw new NotFoundException('Rule not found');
  }

  private async findOne(id: string): Promise<IncompatibilityRuleDto> {
    const row = await this.rules.findOne({ _id: id }).exec();
    if (!row) throw new NotFoundException('Rule not found');
    const [withSides] = await this.attachSides([row]);
    return toDto(withSides);
  }

  /** The forbidden pairs in one set of ingredients, with their names. */
  async findConflicts(ingredientIds: string[]): Promise<RecipeConflictDto[]> {
    const [conflicts] = await this.findConflictsForEach([ingredientIds]);
    if (conflicts.length === 0) return [];
    const ingredients = await this.ingredients
      .find({ _id: { $in: ingredientIds } })
      .exec();
    const byId = new Map(ingredients.map(({ id, name }) => [id, { id, name }]));
    return conflicts.flatMap(({ ingredientAId, ingredientBId, ...rest }) => {
      const a = byId.get(ingredientAId);
      const b = byId.get(ingredientBId);
      return a && b ? [{ ...rest, a, b }] : [];
    });
  }

  /** Conflicts of several ingredient sets, reading groups and rules once. */
  async findConflictsForEach(
    ingredientSets: string[][],
  ): Promise<IngredientConflict[][]> {
    const ingredientIds = [...new Set(ingredientSets.flat())];
    if (ingredientIds.length < 2) return ingredientSets.map(() => []);

    const memberships = await this.members
      .find({ ingredientId: { $in: ingredientIds } })
      .exec();
    const groupsByIngredient = new Map<string, Set<string>>();
    for (const { ingredientId, groupId } of memberships) {
      const groups = groupsByIngredient.get(ingredientId) ?? new Set();
      groups.add(groupId);
      groupsByIngredient.set(ingredientId, groups);
    }
    const groupIds = [...new Set(memberships.map(({ groupId }) => groupId))];

    const rules = await this.rules
      .find({
        $and: [
          {
            $or: [
              { aIngredientId: { $in: ingredientIds } },
              { aGroupId: { $in: groupIds } },
            ],
          },
          {
            $or: [
              { bIngredientId: { $in: ingredientIds } },
              { bGroupId: { $in: groupIds } },
            ],
          },
        ],
      })
      .sort({ createdAt: 1, _id: 1 })
      .exec();
    const conflictRules: ConflictRule[] = rules.map(
      ({
        id,
        aIngredientId,
        aGroupId,
        bIngredientId,
        bGroupId,
        reason,
        source,
      }) => ({
        id,
        aIngredientId,
        aGroupId,
        bIngredientId,
        bGroupId,
        reason,
        source,
      }),
    );
    return ingredientSets.map((ids) =>
      detectConflicts(ids, groupsByIngredient, conflictRules),
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
    // A side names either an ingredient or a group; only the named ones are checked.
    const ingredientIds: string[] = [];
    const groupIds: string[] = [];
    for (const side of [a, b]) {
      if (side.ingredientId !== null) ingredientIds.push(side.ingredientId);
      if (side.groupId !== null) groupIds.push(side.groupId);
    }
    const [ingredients, groups] = await Promise.all([
      allExist(this.ingredients, ingredientIds),
      allExist(this.groups, groupIds),
    ]);
    if (!ingredients || !groups) {
      throw badRequest(
        'UNKNOWN_REFERENCE',
        'An id in the request does not exist',
      );
    }
    const matches = (sides: ReturnType<typeof pair>) =>
      Object.fromEntries(Object.entries(sides));
    const filter: Record<string, unknown> = {
      $or: [matches(pair(a, b)), matches(pair(b, a))],
    };
    if (selfId) filter._id = { $ne: selfId };
    const duplicate = await this.rules.findOne(filter).select('_id').exec();
    if (duplicate) {
      throw conflict('RULE_EXISTS', 'A rule for this pair already exists');
    }
    return {
      ...pair(a, b),
      reason: dto.reason,
      source: dto.source || null,
    };
  }

  /** Resolves each rule's sides to ingredient or group names. */
  private async attachSides(
    rows: HydratedDocument<IncompatibilityRule>[],
  ): Promise<RuleRow[]> {
    const ingredientIds = [
      ...new Set(
        rows.flatMap(({ aIngredientId, bIngredientId }) =>
          [aIngredientId, bIngredientId].filter(
            (id): id is string => id !== null,
          ),
        ),
      ),
    ];
    const groupIds = [
      ...new Set(
        rows.flatMap(({ aGroupId, bGroupId }) =>
          [aGroupId, bGroupId].filter((id): id is string => id !== null),
        ),
      ),
    ];
    const [ingredients, groups] = await Promise.all([
      this.ingredients.find({ _id: { $in: ingredientIds } }).exec(),
      this.groups.find({ _id: { $in: groupIds } }).exec(),
    ]);
    const ingredientById = new Map(
      ingredients.map(({ id, name }) => [id, { id, name }]),
    );
    const groupById = new Map(groups.map(({ id, name }) => [id, { id, name }]));
    const named = (map: Map<string, Named>, id: string | null): Named | null =>
      id === null ? null : (map.get(id) ?? null);
    return rows.map((row) => ({
      ...(row.toObject() as IncompatibilityRule),
      aIngredient: named(ingredientById, row.aIngredientId),
      aGroup: named(groupById, row.aGroupId),
      bIngredient: named(ingredientById, row.bIngredientId),
      bGroup: named(groupById, row.bGroupId),
    }));
  }
}

function toSideDto(
  ingredient: { id: string; name: string } | null,
  group: { id: string; name: string } | null,
): RuleSideDto {
  if (ingredient) {
    return { kind: 'INGREDIENT', id: ingredient.id, name: ingredient.name };
  }
  if (group) return { kind: 'GROUP', id: group.id, name: group.name };
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
