import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiFeature, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const TIME_ZONE = 'Asia/Bangkok';
const DAY_MS = 86_400_000;

export interface AiUsageSummary {
  feature: AiFeature;
  used: number;
  limit: number;
  /** Next midnight in Asia/Bangkok, when every count starts over. */
  resetsAt: Date;
}

/**
 * Daily allowances for paid AI features, counted per user in PostgreSQL so
 * every API instance sees the same totals. Days follow Asia/Bangkok, like the
 * admin dashboard.
 */
@Injectable()
export class AiUsageService {
  private readonly limits: Record<AiFeature, number>;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.limits = {
      [AiFeature.BLOG_CHAT]: configService.get<number>(
        'BLOG_AI_DAILY_MESSAGES',
        100,
      ),
      [AiFeature.BLOG_IMAGE]: configService.get<number>(
        'BLOG_AI_DAILY_IMAGES',
        10,
      ),
    };
  }

  /**
   * Counts one use, unless today's allowance is spent. A single statement, so
   * parallel requests cannot both take the last use.
   */
  async consume(
    userId: string,
    feature: AiFeature,
    now = new Date(),
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ count: number }[]>(Prisma.sql`
      INSERT INTO ai_usage (user_id, day, feature, count)
      VALUES (${userId}::uuid, ${bangkokDay(now)}::date, ${feature}::"AiFeature", 1)
      ON CONFLICT (user_id, day, feature)
      DO UPDATE SET count = ai_usage.count + 1
      WHERE ai_usage.count < ${this.limits[feature]}
      RETURNING count
    `);
    return rows.length > 0;
  }

  /** Gives back a use that produced nothing (refused or failed upstream). */
  async refund(
    userId: string,
    feature: AiFeature,
    now = new Date(),
  ): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE ai_usage SET count = count - 1
      WHERE user_id = ${userId}::uuid AND day = ${bangkokDay(now)}::date
        AND feature = ${feature}::"AiFeature" AND count > 0
    `);
  }

  async summary(
    userId: string,
    feature: AiFeature,
    now = new Date(),
  ): Promise<AiUsageSummary> {
    const day = bangkokDay(now);
    const row = await this.prisma.aiUsage.findUnique({
      where: {
        userId_day_feature: {
          userId,
          day: new Date(`${day}T00:00:00Z`),
          feature,
        },
      },
      select: { count: true },
    });
    return {
      feature,
      used: row?.count ?? 0,
      limit: this.limits[feature],
      // Bangkok is UTC+07:00 with no DST
      resetsAt: new Date(Date.parse(`${day}T00:00:00+07:00`) + DAY_MS),
    };
  }
}

/** The calendar day in Asia/Bangkok, as YYYY-MM-DD. */
export function bangkokDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
