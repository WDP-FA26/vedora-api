import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AiFeature, AiRequest } from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { lockDocument } from '../mongo/document-lock.js';
import { isUniqueViolation } from '../mongo/errors.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import {
  SubscriptionsService,
  type SubscriptionPeriod,
} from './subscriptions.service.js';

const LEASE_MS = 10 * 60_000;
const MAX_REQUESTS_PER_TURN = 8;
export const usageHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface UsageContext {
  requestId?: string;
  input?: unknown;
  prompt?: unknown;
  continuation?: boolean;
}
export interface UsageTicket {
  id: string;
  token: string;
  hash: string;
}
export interface AiUsageSummary {
  feature: AiFeature;
  used: number;
  limit: number;
  remaining: number;
  resetsAt: Date;
  period: 'DAY' | 'CYCLE';
}

@Injectable()
export class AiUsageService {
  constructor(
    @InjectModel(AiRequest.name) private readonly requests: Model<AiRequest>,
    private readonly subscriptions: SubscriptionsService,
    private readonly mongo: MongoService,
  ) {}

  private bucket(feature: AiFeature): 'TEXT' | 'IMAGE' {
    return feature === AiFeature.BLOG_IMAGE ? 'IMAGE' : 'TEXT';
  }

  private countFilter(
    userId: string,
    period: SubscriptionPeriod,
    feature: AiFeature,
    now: Date,
  ) {
    return {
      userId,
      periodKey: period.key,
      bucket: this.bucket(feature),
      $or: [
        { charged: true },
        { status: 'RESERVED' as const, leaseUntil: { $gt: now } },
      ],
    };
  }

  async summary(
    userId: string,
    feature: AiFeature,
    now = new Date(),
  ): Promise<AiUsageSummary> {
    const period = await this.subscriptions.period(userId, now);
    return this.summaryForPeriod(userId, feature, period, now);
  }

  async summaryForPeriod(
    userId: string,
    feature: AiFeature,
    period: SubscriptionPeriod,
    now = new Date(),
  ): Promise<AiUsageSummary> {
    const used = await this.requests
      .countDocuments(this.countFilter(userId, period, feature, now))
      .exec();
    const limit =
      feature === AiFeature.BLOG_IMAGE ? period.imageLimit : period.textLimit;
    return {
      feature,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      resetsAt: period.expiresAt,
      period: period.planCode === 'FREE' ? 'DAY' : 'CYCLE',
    };
  }

  async consume(
    userId: string,
    feature: AiFeature,
    context: UsageContext = {},
    now = new Date(),
  ): Promise<UsageTicket | null> {
    const requestKey = context.requestId ?? randomUUID();
    if (!requestKey.length || requestKey.length > 200)
      throw new InvalidInputException('BAD_REQUEST', 'Invalid AI request ID');
    const hash = usageHash(context.input ?? requestKey);
    const promptHash = usageHash(context.prompt ?? context.input ?? requestKey);
    const token = randomUUID();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.mongo.withTransaction(async (session) => {
          // Use the payment capture lock: a request belongs wholly to one cycle.
          await lockDocument(this.mongo, session, 'payer', userId);
          const period = await this.subscriptions.period(userId, now, session);
          let row = await this.requests
            .findOne({ userId, feature, requestKey })
            .session(session)
            .exec();
          if (row) {
            if (row.promptHash !== promptHash)
              throw new StateConflictException(
                'IDEMPOTENCY_CONFLICT',
                'This AI request ID belongs to another prompt',
              );
            if (
              row.status === 'RESERVED' &&
              row.leaseUntil &&
              row.leaseUntil > now
            )
              throw new StateConflictException(
                'AI_REQUEST_IN_PROGRESS',
                'This AI request is still being processed',
              );
            if (row.status === 'RESERVED' && row.activeHash) {
              const expiredHash = row.activeHash;
              row.requestHashes = row.requestHashes.filter(
                (value) => value !== expiredHash,
              );
            }
            if (row.requestHashes.includes(hash))
              throw new StateConflictException(
                'AI_REQUEST_ALREADY_PROCESSED',
                'This AI request has already been processed',
              );
            if (
              row.charged &&
              (!context.continuation ||
                row.periodKey !== period.key ||
                row.requestHashes.length >= MAX_REQUESTS_PER_TURN)
            )
              throw new StateConflictException(
                'AI_REQUEST_EXPIRED',
                'Start a new assistant request',
              );
          } else if (context.continuation) {
            throw new StateConflictException(
              'AI_REQUEST_EXPIRED',
              'The original assistant request is unavailable',
            );
          }
          if (!row?.charged) {
            const limit =
              feature === AiFeature.BLOG_IMAGE
                ? period.imageLimit
                : period.textLimit;
            const used = await this.requests
              .countDocuments(this.countFilter(userId, period, feature, now))
              .session(session)
              .exec();
            if (used >= limit) return null;
          }
          if (!row)
            row = new this.requests({
              userId,
              feature,
              requestKey,
              promptHash,
              bucket: this.bucket(feature),
              charged: false,
              requestHashes: [],
            });
          row.periodKey = period.key;
          row.status = 'RESERVED';
          row.leaseToken = token;
          row.leaseUntil = new Date(now.getTime() + LEASE_MS);
          row.activeHash = hash;
          row.requestHashes.push(hash);
          await row.save({ session });
          return { id: row.id, token, hash };
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new StateConflictException(
      'CONFLICT',
      'AI usage changed; retry the same request',
    );
  }

  async complete(ticket: UsageTicket): Promise<void> {
    await this.requests
      .updateOne(
        { _id: ticket.id, leaseToken: ticket.token, status: 'RESERVED' },
        {
          $set: {
            charged: true,
            status: 'COMPLETED',
            leaseToken: null,
            leaseUntil: null,
            activeHash: null,
          },
        },
      )
      .exec();
  }

  async refund(ticket: UsageTicket): Promise<void> {
    // Ticket identity keeps a late failure from crediting a newly purchased cycle.
    await this.requests
      .updateOne(
        { _id: ticket.id, leaseToken: ticket.token, status: 'RESERVED' },
        {
          $set: {
            status: 'REFUNDED',
            leaseToken: null,
            leaseUntil: null,
            activeHash: null,
          },
          $pull: { requestHashes: ticket.hash },
        },
      )
      .exec();
  }
}
