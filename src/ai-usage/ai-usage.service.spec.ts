import { ConfigService } from '@nestjs/config';
import { AiFeature } from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import { AiUsageService, bangkokDay } from './ai-usage.service';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
// 23:30 on 22 October in UTC is already 23 October in Bangkok
const NOW = new Date('2026-10-22T17:30:00Z');

describe('AiUsageService', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: AiUsageService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new AiUsageService(
      prisma,
      new ConfigService({ BLOG_AI_DAILY_MESSAGES: 3, BLOG_AI_DAILY_IMAGES: 2 }),
    );
  });

  it('counts days in Asia/Bangkok', () => {
    expect(bangkokDay(NOW)).toBe('2026-10-23');
    expect(bangkokDay(new Date('2026-10-22T16:59:59Z'))).toBe('2026-10-22');
  });

  it('takes a use while the allowance lasts', async () => {
    prisma.$queryRaw.mockResolvedValue([{ count: 1 }]);

    await expect(
      service.consume(USER_ID, AiFeature.BLOG_IMAGE, NOW),
    ).resolves.toBe(true);

    const [sql] = prisma.$queryRaw.mock.calls[0] as unknown as [
      { values: unknown[] },
    ];
    expect(sql.values).toEqual([USER_ID, '2026-10-23', 'BLOG_IMAGE', 2]);
  });

  it('refuses once the conditional upsert returns no row', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(
      service.consume(USER_ID, AiFeature.BLOG_CHAT, NOW),
    ).resolves.toBe(false);
  });

  it('gives back a use on the same day', async () => {
    prisma.$executeRaw.mockResolvedValue(1);

    await service.refund(USER_ID, AiFeature.BLOG_CHAT, NOW);

    const [sql] = prisma.$executeRaw.mock.calls[0] as unknown as [
      { values: unknown[] },
    ];
    expect(sql.values).toEqual([USER_ID, '2026-10-23', 'BLOG_CHAT']);
  });

  it('summarises usage with the next Bangkok midnight', async () => {
    prisma.aiUsage.findUnique.mockResolvedValue({
      userId: USER_ID,
      day: new Date('2026-10-23T00:00:00Z'),
      feature: AiFeature.BLOG_CHAT,
      count: 2,
    });

    await expect(
      service.summary(USER_ID, AiFeature.BLOG_CHAT, NOW),
    ).resolves.toEqual({
      feature: AiFeature.BLOG_CHAT,
      used: 2,
      limit: 3,
      resetsAt: new Date('2026-10-23T17:00:00Z'),
    });
  });

  it('reports nothing used on a fresh day', async () => {
    prisma.aiUsage.findUnique.mockResolvedValue(null);

    const summary = await service.summary(USER_ID, AiFeature.BLOG_IMAGE, NOW);

    expect(summary).toMatchObject({ used: 0, limit: 2 });
  });
});
