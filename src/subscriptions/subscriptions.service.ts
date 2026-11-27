import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import {
  PaymentIntent,
  PaymentStatus,
  SubscriptionMembership,
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
  source?: 'ADMIN_GRANT';
}

@Injectable()
export class SubscriptionsService {
  constructor(
    @InjectModel(PaymentIntent.name)
    private readonly intents: Model<PaymentIntent>,
    @InjectModel(SubscriptionMembership.name)
    private readonly memberships: Model<SubscriptionMembership>,
    private readonly catalog: SubscriptionCatalogService,
  ) {}

  /** Caller must hold the payer lock, inside the capture/grant transaction. */
  async assign(
    userId: string,
    assignment: Omit<
      SubscriptionMembership,
      'id' | '_id' | 'createdAt' | 'updatedAt'
    >,
    session: ClientSession,
  ): Promise<void> {
    await this.memberships
      .updateOne(
        { _id: userId },
        { $set: assignment },
        { upsert: true, session },
      )
      .exec();
  }

  async activatePayment(
    intent: PaymentIntent,
    capturedAt: Date,
    session: ClientSession,
  ): Promise<void> {
    const limits = purchasedLimits(intent);
    await this.assign(
      intent.userId,
      {
        source: 'PAYMENT',
        sourceId: intent.id,
        planCode: effectivePlan(intent),
        startsAt: capturedAt,
        expiresAt: new Date(
          capturedAt.getTime() + intent.durationDays * 86_400_000,
        ),
        textLimit: limits.text,
        imageLimit: limits.images,
      },
      session,
    );
  }

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
    const assigned = await this.memberships
      .findById(userId)
      .session(session ?? null)
      .exec();
    if (assigned) {
      if (assigned.expiresAt > now)
        return {
          planCode: assigned.planCode,
          key: `${assigned.source === 'PAYMENT' ? 'payment' : 'admin-grant'}:${assigned.sourceId}`,
          startsAt: assigned.startsAt,
          expiresAt: assigned.expiresAt,
          textLimit: assigned.textLimit,
          imageLimit: assigned.imageLimit,
          ...(assigned.source === 'ADMIN_GRANT'
            ? { source: 'ADMIN_GRANT' as const }
            : {}),
        };
      return this.free(now, session);
    }
    // Compatibility for purchases captured before assignments were introduced.
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
    return this.free(now, session);
  }

  private async free(
    now: Date,
    session?: ClientSession,
  ): Promise<SubscriptionPeriod> {
    const { freeLimits } = await this.catalog.current(session);
    return {
      planCode: 'FREE',
      ...freePeriod(now),
      textLimit: freeLimits.textLimit,
      imageLimit: freeLimits.imageLimit,
    };
  }
}
