import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { isUniqueViolation } from '../../mongo/errors';
import { AiFeature, AiUsage } from '../../mongo/models';

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
 * Daily allowances for paid AI features, counted per user in MongoDB so
 * every API instance sees the same totals. Days follow Asia/Bangkok, like the
 * admin dashboard.
 */
@Injectable()
export class AiUsageService {
  private readonly limits: Record<AiFeature, number>;

  constructor(
    @InjectModel(AiUsage.name) private readonly usage: Model<AiUsage>,
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
   * Counts one use, unless today's allowance is spent. Each step is a single
   * conditional write, so parallel requests cannot both take the last use.
   */
  async consume(
    userId: string,
    feature: AiFeature,
    now = new Date(),
  ): Promise<boolean> {
    const limit = this.limits[feature];
    const day = new Date(`${bangkokDay(now)}T00:00:00Z`);
    const take = async (): Promise<boolean> =>
      (await this.usage
        .findOneAndUpdate(
          { userId, day, feature, count: { $lt: limit } },
          { $inc: { count: 1 } },
          { returnDocument: 'after' },
        )
        .exec()) !== null;
    if (await take()) return true;
    if (limit < 1) return false;
    try {
      await this.usage.create({ userId, day, feature, count: 1 });
      return true;
    } catch (error) {
      // The row exists: it is full, or a parallel request just created it.
      if (!isUniqueViolation(error)) throw error;
      return take();
    }
  }

  /** Gives back a use that produced nothing (refused or failed upstream). */
  async refund(
    userId: string,
    feature: AiFeature,
    now = new Date(),
  ): Promise<void> {
    await this.usage
      .updateOne(
        {
          userId,
          day: new Date(`${bangkokDay(now)}T00:00:00Z`),
          feature,
          count: { $gt: 0 },
        },
        { $inc: { count: -1 } },
      )
      .exec();
  }

  async summary(
    userId: string,
    feature: AiFeature,
    now = new Date(),
  ): Promise<AiUsageSummary> {
    const day = bangkokDay(now);
    const row = await this.usage
      .findOne({ userId, day: new Date(`${day}T00:00:00Z`), feature })
      .select('count')
      .exec();
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
