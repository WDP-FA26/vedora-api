import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import {
  AccountStatus,
  AccountType,
  PaymentIntent,
  PaymentStatus,
  SubscriptionGrant,
  User,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { lockDocument } from '../mongo/document-lock.js';
import { isUniqueViolation } from '../mongo/errors.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { SubscriptionCatalogService } from './subscription-catalog.service.js';
import { SubscriptionsService } from './subscriptions.service.js';
import type {
  CreateSubscriptionGrantDto,
  SubscriptionUserQueryDto,
} from './subscription-grant.dto.js';

const eligible = {
  accountType: AccountType.PERSONAL,
  status: {
    $in: [
      AccountStatus.ACTIVE,
      AccountStatus.PENDING_EMAIL,
      AccountStatus.SUSPENDED,
    ],
  },
};
const identity = (user: User) => ({
  id: user.id,
  username: user.username,
  fullName: user.fullName,
  email: user.email,
  role: user.role,
  status: user.status,
});
export function grantRow(row: SubscriptionGrant) {
  return {
    id: row.id,
    userId: row.userId,
    actorId: row.actorId,
    reason: row.reason,
    planCode: row.planCode,
    catalogVersion: row.catalogVersion,
    durationDays: row.durationDays,
    textLimit: row.textLimit,
    imageLimit: row.imageLimit,
    startsAt: row.startsAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class SubscriptionGrantsService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(SubscriptionGrant.name)
    private readonly grants: Model<SubscriptionGrant>,
    @InjectModel(PaymentIntent.name)
    private readonly intents: Model<PaymentIntent>,
    private readonly mongo: MongoService,
    private readonly subscriptions: SubscriptionsService,
    private readonly catalog: SubscriptionCatalogService,
  ) {}

  async search(query: SubscriptionUserQueryDto) {
    const q = query.q?.trim();
    const escaped = q
      ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      : null;
    const filter = {
      ...eligible,
      ...(query.status
        ? {
            status: {
              $in: [query.status].filter(
                (status) =>
                  status !== AccountStatus.DELETED &&
                  status !== AccountStatus.SYSTEM,
              ),
            },
          }
        : {}),
      ...(escaped
        ? {
            $or: [
              { _id: q!.toLowerCase() },
              ...['username', 'fullName', 'email'].map((field) => ({
                [field]: escaped,
              })),
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.users
        .find(filter)
        .select('_id username fullName email role status')
        .sort({ username: 1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.users.countDocuments(filter).exec(),
    ]);
    return {
      items: rows.map(identity),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  private async target(id: string, session?: ClientSession) {
    const user = await this.users
      .findOne({ _id: id, ...eligible })
      .session(session ?? null)
      .exec();
    if (!user)
      throw new ResourceNotFoundException(
        'NOT_FOUND',
        'Personal user not found or unavailable',
      );
    return user;
  }

  async detail(userId: string) {
    userId = userId.toLowerCase();
    const user = await this.target(userId);
    const now = new Date();
    const [period, pending, recent] = await Promise.all([
      this.subscriptions.period(userId, now),
      this.intents
        .findOne({
          userId,
          status: PaymentStatus.PENDING,
          expiresAt: { $gt: now },
        })
        .select('_id planCode amount expiresAt')
        .exec(),
      this.grants
        .find({ userId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(5)
        .exec(),
    ]);
    return {
      user: identity(user),
      membership: {
        ...period,
        startsAt: period.startsAt.toISOString(),
        expiresAt: period.expiresAt.toISOString(),
        source:
          period.source ?? (period.planCode === 'FREE' ? 'FREE' : 'PAYMENT'),
      },
      pendingPayment: pending
        ? { id: pending.id, expiresAt: pending.expiresAt!.toISOString() }
        : null,
      recentGrants: recent.map(grantRow),
    };
  }

  async create(
    actorId: string,
    input: CreateSubscriptionGrantDto,
    key?: string,
  ) {
    if (!key || !/^[a-zA-Z0-9._:-]{8,200}$/.test(key))
      throw new InvalidInputException(
        'BAD_REQUEST',
        'A valid Idempotency-Key is required',
      );
    const body = {
      userId: input.userId.toLowerCase(),
      planCode: input.planCode,
      catalogVersion: input.catalogVersion,
      expectedPeriodKey: input.expectedPeriodKey,
      reason: input.reason.trim(),
    };
    const hash = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
    const replay = (row: SubscriptionGrant) => {
      if (row.payloadHash !== hash)
        throw new StateConflictException(
          'IDEMPOTENCY_CONFLICT',
          'Key already used with a different grant',
        );
      return grantRow(row);
    };
    try {
      return await this.mongo.withTransaction(async (session) => {
        await lockDocument(this.mongo, session, 'payer', body.userId);
        const prior = await this.grants
          .findOne({ actorId, requestKey: key })
          .session(session)
          .exec();
        if (prior) return replay(prior); // Never reactivate an overwritten grant on retry.
        await this.target(body.userId, session);
        const now = new Date();
        const current = await this.subscriptions.period(
          body.userId,
          now,
          session,
        );
        if (current.key !== body.expectedPeriodKey)
          throw new StateConflictException(
            'SUBSCRIPTION_PERIOD_CONFLICT',
            'Membership changed; reload the user before granting',
          );
        const catalog = await this.catalog.current(session);
        if (catalog.version !== body.catalogVersion)
          throw new StateConflictException(
            'SUBSCRIPTION_CATALOG_CONFLICT',
            'Plan configuration changed; reload before granting',
          );
        const plan = catalog.plans.find((plan) => plan.code === body.planCode)!;
        const expiresAt = new Date(
          now.getTime() + plan.durationDays * 86_400_000,
        );
        const [row] = await this.grants.create(
          [
            {
              ...body,
              actorId,
              requestKey: key,
              payloadHash: hash,
              startsAt: now,
              expiresAt,
              durationDays: plan.durationDays,
              textLimit: plan.textLimit,
              imageLimit: plan.imageLimit,
            },
          ],
          { session },
        );
        await this.subscriptions.assign(
          body.userId,
          {
            source: 'ADMIN_GRANT',
            sourceId: row.id,
            planCode: body.planCode,
            startsAt: now,
            expiresAt,
            textLimit: plan.textLimit,
            imageLimit: plan.imageLimit,
          },
          session,
        );
        return grantRow(row);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const prior = await this.grants
        .findOne({ actorId, requestKey: key })
        .exec();
      if (prior) return replay(prior);
      throw error;
    }
  }
}
