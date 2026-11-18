import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { PaymentIntent, PaymentStatus } from '../mongo/models.js';
import {
  effectivePlan,
  freePeriod,
  SUBSCRIPTION_LIMITS,
  purchasedLimits,
  type SubscriptionPlan,
} from './subscription-policy.js';

export interface SubscriptionPeriod {
  planCode: SubscriptionPlan;
  key: string;
  startsAt: Date;
  expiresAt: Date;
  textLimit: number;
  imageLimit: number;
}

@Injectable()
export class SubscriptionsService {
  constructor(
    @InjectModel(PaymentIntent.name)
    private readonly intents: Model<PaymentIntent>,
  ) {}

  async period(
    userId: string,
    now = new Date(),
    session?: ClientSession,
  ): Promise<SubscriptionPeriod> {
    const query = this.intents
      .findOne({ userId, status: PaymentStatus.SUCCEEDED })
      .sort({ capturedAt: -1, _id: -1 });
    if (session) query.session(session);
    const latest = await query.exec();
    if (latest?.capturedAt) {
      const expiresAt = new Date(
        latest.capturedAt.getTime() + latest.durationDays * 86_400_000,
      );
      if (expiresAt > now) {
        const planCode = effectivePlan(latest),
          limits = purchasedLimits(latest);
        return {
          planCode,
          key: `payment:${latest.id}`,
          startsAt: latest.capturedAt,
          expiresAt,
          textLimit: limits.text,
          imageLimit: limits.images,
        };
      }
    }
    return {
      planCode: 'FREE',
      ...freePeriod(now),
      textLimit: SUBSCRIPTION_LIMITS.FREE.text,
      imageLimit: SUBSCRIPTION_LIMITS.FREE.images,
    };
  }
}
