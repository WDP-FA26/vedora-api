import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { runtimeConfig } from '../config/runtime-config.js';
import { calendarDay, zonedMidnight } from '../config/time-zone.js';
import {
  BillingPlan,
  PaymentIntent,
  PaymentStatus,
  User,
  UserRole,
} from '../mongo/models.js';
import {
  effectivePlan,
  freePeriod,
  purchasedLimits,
  type SubscriptionPlan,
} from './subscription-policy.js';
import { SubscriptionCatalogService } from './subscription-catalog.service.js';
import { AccessDeniedException } from '../common/exceptions/access-denied.exception.js';

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
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly catalog: SubscriptionCatalogService,
  ) {}

  async requireProVoice(
    userId: string,
    now = new Date(),
    session?: ClientSession,
  ): Promise<SubscriptionPeriod> {
    const period = await this.period(userId, now, session);
    if (period.planCode !== 'PRO') {
      throw new AccessDeniedException(
        'PRO_REQUIRED',
        'Two-way AI voice requires an active Pro subscription',
      );
    }
    return period;
  }

  async period(
    userId: string,
    now = new Date(),
    session?: ClientSession,
  ): Promise<SubscriptionPeriod> {
    if (await this.isAdmin(userId, session)) {
      return this.adminPeriod(now, session);
    }
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
    const { freeLimits } = await this.catalog.current(session);
    return {
      planCode: 'FREE',
      ...freePeriod(now),
      textLimit: freeLimits.textLimit,
      imageLimit: freeLimits.imageLimit,
    };
  }

  private async isAdmin(
    userId: string,
    session?: ClientSession,
  ): Promise<boolean> {
    const query = this.users.exists({ _id: userId, role: UserRole.ADMIN });
    if (session) query.session(session);
    return (await query.exec()) !== null;
  }

  private async adminPeriod(
    now: Date,
    session?: ClientSession,
  ): Promise<SubscriptionPeriod> {
    const { plans } = await this.catalog.current(session);
    const pro = plans.find((plan) => plan.code === BillingPlan.PRO);
    if (!pro) throw new Error('Subscription catalog has no Pro plan');
    return {
      planCode: 'PRO',
      ...monthPeriod(now),
      textLimit: pro.textLimit,
      imageLimit: pro.imageLimit,
    };
  }
}

function monthPeriod(now: Date) {
  const month = calendarDay(now, runtimeConfig.APP_TIMEZONE).slice(0, 7);
  const [year, monthNumber] = month.split('-').map(Number);
  const next =
    monthNumber === 12
      ? `${year + 1}-01`
      : `${year}-${String(monthNumber + 1).padStart(2, '0')}`;
  return {
    key: `admin:${month}`,
    startsAt: zonedMidnight(`${month}-01`, runtimeConfig.APP_TIMEZONE),
    expiresAt: zonedMidnight(`${next}-01`, runtimeConfig.APP_TIMEZONE),
  };
}
