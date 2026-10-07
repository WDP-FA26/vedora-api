import { BadRequestException, ConflictException } from '@nestjs/common';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import { IncompatibilityRulesService } from './incompatibility-rules.service';

const tofu = 'a1a2d3e4-0000-4000-8000-000000000001';
const spinach = 'a1a2d3e4-0000-4000-8000-000000000002';
const greens = 'b1a2d3e4-0000-4000-8000-000000000001';
const now = new Date('2026-10-07T08:00:00Z');
const row = {
  id: 'c1a2d3e4-0000-4000-8000-000000000001',
  aIngredientId: tofu,
  aGroupId: null,
  bIngredientId: null,
  bGroupId: greens,
  reason: 'Oxalat cản hấp thu canxi',
  source: null,
  createdAt: now,
  updatedAt: now,
  aIngredient: { id: tofu, name: 'Đậu hũ' },
  aGroup: null,
  bIngredient: null,
  bGroup: { id: greens, name: 'Rau giàu oxalat' },
};

describe('IncompatibilityRulesService', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: IncompatibilityRulesService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new IncompatibilityRulesService(prisma);
  });

  it('stores each side as an ingredient or a group', async () => {
    prisma.incompatibilityRule.findFirst.mockResolvedValue(null);
    prisma.incompatibilityRule.create.mockResolvedValue(row);

    const rule = await service.create({
      a: { kind: 'INGREDIENT', id: tofu },
      b: { kind: 'GROUP', id: greens },
      reason: row.reason,
    });

    expect(prisma.incompatibilityRule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          aIngredientId: tofu,
          aGroupId: null,
          bIngredientId: null,
          bGroupId: greens,
          reason: row.reason,
          source: null,
        },
      }),
    );
    expect(rule.a).toEqual({ kind: 'INGREDIENT', id: tofu, name: 'Đậu hũ' });
    expect(rule.b).toEqual({
      kind: 'GROUP',
      id: greens,
      name: 'Rau giàu oxalat',
    });
  });

  it('rejects an ingredient paired with itself', async () => {
    await expect(
      service.create({
        a: { kind: 'INGREDIENT', id: tofu },
        b: { kind: 'INGREDIENT', id: tofu },
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a pair that already has a rule, in either order', async () => {
    prisma.incompatibilityRule.findFirst.mockResolvedValue(row);

    await expect(
      service.create({
        a: { kind: 'GROUP', id: greens },
        b: { kind: 'INGREDIENT', id: tofu },
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.incompatibilityRule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            expect.objectContaining({ aGroupId: greens, bIngredientId: tofu }),
            expect.objectContaining({ aIngredientId: tofu, bGroupId: greens }),
          ],
        },
      }),
    );
  });

  it('finds conflicts through group membership and names both sides', async () => {
    prisma.ingredientGroupMember.findMany.mockResolvedValue([
      { ingredientId: spinach, groupId: greens },
    ]);
    prisma.incompatibilityRule.findMany.mockResolvedValue([row]);
    prisma.ingredient.findMany.mockResolvedValue([
      { id: tofu, name: 'Đậu hũ' },
      { id: spinach, name: 'Rau bina' },
    ] as never);

    await expect(service.findConflicts([tofu, spinach])).resolves.toEqual([
      {
        ruleId: row.id,
        reason: row.reason,
        source: null,
        a: { id: tofu, name: 'Đậu hũ' },
        b: { id: spinach, name: 'Rau bina' },
      },
    ]);
  });

  it('skips the database for fewer than two ingredients', async () => {
    await expect(service.findConflicts([tofu])).resolves.toEqual([]);
    expect(prisma.incompatibilityRule.findMany).not.toHaveBeenCalled();
  });
});
