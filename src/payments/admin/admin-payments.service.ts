import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, PipelineStage } from 'mongoose';
import {
  PaymentIntent,
  PaymentWebhookReceipt,
  PaymentStatus,
} from '../../mongo/models.js';
import { resolveDashboardRange } from '../../admin-dashboard/dashboard-range.js';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service.js';
import { InvalidInputException } from '../../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../common/exceptions/resource-not-found.exception.js';
import {
  customerJoin,
  cycleExpiry,
  normalizedPlan,
  orderRow,
  receiptRow,
  csvCell,
  type AdminIntent,
} from './admin-payment-mapping.js';
import type {
  AdminPaymentListDto,
  AdminPaymentPageDto,
  AdminPaymentQueryDto,
  AdminReceiptQueryDto,
  AdminSubscriptionQueryDto,
} from './admin-payment-query.dto.js';

const sumVnd = { $sum: { $toDecimal: '$amount' } };
type Count = { _id: string; count: number };
type Revenue = {
  _id: string | null;
  count: number;
  amount: { toString(): string };
  buyers?: number;
};

@Injectable()
export class AdminPaymentsService {
  constructor(
    @InjectModel(PaymentIntent.name)
    private readonly intents: Model<PaymentIntent>,
    @InjectModel(PaymentWebhookReceipt.name)
    private readonly receipts: Model<PaymentWebhookReceipt>,
    private readonly subscriptions: SubscriptionsService,
  ) {}
  private scope(
    query: AdminPaymentQueryDto,
    dateField: 'createdAt' | 'capturedAt',
  ): PipelineStage[] {
    const range = resolveDashboardRange(query);
    const pipeline: PipelineStage[] = [
      {
        $match: {
          [dateField]: { $gte: range.start, $lt: range.endExclusive },
          ...(query.userId ? { userId: query.userId.toLowerCase() } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
      },
      { $set: { normalizedPlan } },
      ...(query.plan ? [{ $match: { normalizedPlan: query.plan } }] : []),
      ...customerJoin,
    ];
    const q = query.q?.trim();
    if (q) {
      const exact = new RegExp(
        '^' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
        'i',
      );
      pipeline.push({
        $match: {
          $or: [
            { _id: q.toLowerCase() },
            { userId: q.toLowerCase() },
            ...[
              'invoiceNumber',
              'paymentCode',
              'providerTransactionId',
              'customer.username',
              'customer.email',
            ].map((field) => ({ [field]: exact })),
          ],
        },
      });
    }
    return pipeline;
  }
  private active(now: Date): PipelineStage[] {
    return [
      { $match: { status: PaymentStatus.SUCCEEDED } },
      { $sort: { capturedAt: -1, _id: -1 } },
      { $group: { _id: '$userId', latest: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$latest' } },
      { $set: { normalizedPlan, cycleExpiry } },
      { $match: { capturedAt: { $ne: null }, cycleExpiry: { $gt: now } } },
      ...customerJoin,
      {
        $match: {
          'customer.status': 'ACTIVE',
          'customer.emailVerifiedAt': { $ne: null },
        },
      },
    ];
  }
  async orders(query: AdminPaymentListDto) {
    const [result] = await this.intents
      .aggregate<{ items: AdminIntent[]; total: { count: number }[] }>([
        ...this.scope(query, 'createdAt'),
        {
          $facet: {
            items: [
              { $sort: { createdAt: -1, _id: -1 } },
              { $skip: (query.page - 1) * query.limit },
              { $limit: query.limit },
            ],
            total: [{ $count: 'count' }],
          },
        },
      ])
      .exec();
    return {
      items: result.items.map(orderRow),
      total: result.total[0]?.count ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }
  async overview(query: AdminPaymentQueryDto, now = new Date()) {
    const range = resolveDashboardRange(query, now);
    const date = (field: string) => ({
      $dateToString: {
        date: `$${field}`,
        format: '%Y-%m-%d',
        timezone: 'Asia/Bangkok',
      },
    });
    const [[created], [captured], memberships] = await Promise.all([
      this.intents
        .aggregate<{ statuses: Count[]; daily: Count[] }>([
          ...this.scope(
            { ...query, from: range.from, to: range.to },
            'createdAt',
          ),
          {
            $facet: {
              statuses: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
              daily: [
                { $group: { _id: date('createdAt'), count: { $sum: 1 } } },
                { $sort: { _id: 1 } },
              ],
            },
          },
        ])
        .exec(),
      this.intents
        .aggregate<{
          totals: Revenue[];
          plans: Revenue[];
          daily: Revenue[];
          buyers: { count: number }[];
        }>([
          ...this.scope(
            { ...query, from: range.from, to: range.to },
            'capturedAt',
          ),
          { $match: { status: PaymentStatus.SUCCEEDED, currency: 'VND' } },
          {
            $facet: {
              totals: [
                {
                  $group: {
                    _id: null,
                    count: { $sum: 1 },
                    amount: sumVnd,
                  },
                },
              ],
              buyers: [{ $group: { _id: '$userId' } }, { $count: 'count' }],
              plans: [
                {
                  $group: {
                    _id: { plan: '$normalizedPlan', user: '$userId' },
                    count: { $sum: 1 },
                    amount: sumVnd,
                  },
                },
                {
                  $group: {
                    _id: '$_id.plan',
                    count: { $sum: '$count' },
                    amount: { $sum: '$amount' },
                    buyers: { $sum: 1 },
                  },
                },
              ],
              daily: [
                {
                  $group: {
                    _id: date('capturedAt'),
                    count: { $sum: 1 },
                    amount: sumVnd,
                  },
                },
                { $sort: { _id: 1 } },
              ],
            },
          },
        ])
        .exec(),
      this.intents
        .aggregate<Count>([
          ...this.active(now),
          { $group: { _id: '$normalizedPlan', count: { $sum: 1 } } },
        ])
        .exec(),
    ]);
    const total = captured.totals[0];
    const { start: _start, endExclusive: _end, ...publicRange } = range;
    const statuses = { PENDING: 0, SUCCEEDED: 0, CANCELLED: 0 };
    for (const row of created.statuses)
      if (row._id in statuses) statuses[row._id as PaymentStatus] = row.count;
    const members = { PLUS: 0, PRO: 0 };
    for (const row of memberships)
      if (row._id in members)
        members[row._id as keyof typeof members] = row.count;
    const revenue = new Map(captured.daily.map((row) => [row._id, row]));
    const creation = new Map(created.daily.map((row) => [row._id, row.count]));
    const days = [...new Set([...creation.keys(), ...revenue.keys()])]
      .filter((day): day is string => day !== null)
      .sort();
    return {
      generatedAt: now.toISOString(),
      currency: 'VND' as const,
      range: publicRange,
      orderDateBasis: 'createdAt' as const,
      revenueDateBasis: 'capturedAt' as const,
      createdOrders: {
        total: Object.values(statuses).reduce((a, b) => a + b, 0),
        ...statuses,
      },
      captured: {
        count: total?.count ?? 0,
        totalVnd: total?.amount.toString() ?? '0',
        buyers: captured.buyers[0]?.count ?? 0,
        byPlan: captured.plans.map((row) => ({
          planCode: row._id,
          count: row.count,
          totalVnd: row.amount.toString(),
          buyers: row.buyers ?? 0,
        })),
      },
      daily: days.map((day) => ({
        date: day,
        createdOrders: creation.get(day) ?? 0,
        capturedOrders: revenue.get(day)?.count ?? 0,
        confirmedVnd: revenue.get(day)?.amount.toString() ?? '0',
      })),
      membershipSnapshot: {
        asOf: now.toISOString(),
        scope: 'GLOBAL_ACTIVE_VERIFIED_ACCOUNTS' as const,
        ...members,
        total: members.PLUS + members.PRO,
      },
    };
  }
  async detail(id: string, now = new Date()) {
    id = id.toLowerCase();
    const [intent] = await this.intents
      .aggregate<AdminIntent>([{ $match: { _id: id } }, ...customerJoin])
      .exec();
    if (!intent)
      throw new ResourceNotFoundException('NOT_FOUND', 'Payment not found');
    const [period, outcomes] = await Promise.all([
      this.subscriptions.period(intent.userId, now),
      this.receipts
        .aggregate<Count>([
          { $match: { intentId: id } },
          { $group: { _id: '$outcome', count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ])
        .exec(),
    ]);
    return {
      order: orderRow(intent),
      merchant: {
        bankCode: intent.bankCode,
        bankGateway: intent.bankGateway,
        accountLast4: intent.accountNumber.slice(-4),
      },
      currentMembership: {
        planCode: period.planCode,
        startsAt:
          period.planCode === 'FREE' ? null : period.startsAt.toISOString(),
        expiresAt:
          period.planCode === 'FREE' ? null : period.expiresAt.toISOString(),
        isCurrentPurchase: period.key === `payment:${id}`,
      },
      webhookSummary: {
        total: outcomes.reduce((sum, row) => sum + row.count, 0),
        outcomes: outcomes.map((row) => ({
          outcome: row._id,
          count: row.count,
        })),
      },
    };
  }
  async orderReceipts(id: string, query: AdminPaymentPageDto) {
    id = id.toLowerCase();
    if (!(await this.intents.exists({ _id: id })))
      throw new ResourceNotFoundException('NOT_FOUND', 'Payment not found');
    return this.receiptPage({ intentId: id }, query);
  }
  private async receiptPage(
    match: Record<string, unknown>,
    query: AdminPaymentPageDto,
  ) {
    const [rows, total] = await Promise.all([
      this.receipts
        .find(match)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.receipts.countDocuments(match).exec(),
    ]);
    return {
      items: rows.map(receiptRow),
      total,
      page: query.page,
      limit: query.limit,
    };
  }
  receiptsPage(query: AdminReceiptQueryDto) {
    const range = resolveDashboardRange(query);
    return this.receiptPage(
      {
        createdAt: { $gte: range.start, $lt: range.endExclusive },
        ...(query.intentId ? { intentId: query.intentId.toLowerCase() } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
        ...(query.transactionId
          ? { providerTransactionId: query.transactionId }
          : {}),
        ...(query.unmatched
          ? {
              $and: [
                { intentId: query.unmatched === 'true' ? null : { $ne: null } },
              ],
            }
          : {}),
      },
      query,
    );
  }
  async activeSubscriptions(
    query: AdminSubscriptionQueryDto,
    now = new Date(),
  ) {
    const [result] = await this.intents
      .aggregate<{ items: AdminIntent[]; total: { count: number }[] }>([
        ...this.active(now),
        ...(query.plan ? [{ $match: { normalizedPlan: query.plan } }] : []),
        ...(query.userId
          ? [{ $match: { userId: query.userId.toLowerCase() } }]
          : []),
        {
          $facet: {
            items: [
              { $sort: { capturedAt: -1, _id: -1 } },
              { $skip: (query.page - 1) * query.limit },
              { $limit: query.limit },
            ],
            total: [{ $count: 'count' }],
          },
        },
      ])
      .exec();
    return {
      asOf: now.toISOString(),
      items: result.items.map(orderRow),
      total: result.total[0]?.count ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }
  async export(query: AdminPaymentQueryDto) {
    const rows = await this.intents
      .aggregate<AdminIntent>([
        ...this.scope(query, 'createdAt'),
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: 10001 },
      ])
      .exec();
    if (rows.length > 10000)
      throw new InvalidInputException(
        'BAD_REQUEST',
        'CSV exceeds 10000 orders; narrow the filters',
      );
    const headers = [
      'id',
      'userId',
      'username',
      'email',
      'planCode',
      'originalPlanCode',
      'purchasedPlanName',
      'status',
      'amount',
      'currency',
      'invoiceNumber',
      'paymentCode',
      'providerTransactionId',
      'createdAt',
      'capturedAt',
      'paidAt',
      'cancelledAt',
      'subscriptionExpiresAt',
    ] as const;
    return (
      '\ufeff' +
      headers.map(csvCell).join(',') +
      '\r\n' +
      rows
        .map((intent) => {
          const row = orderRow(intent),
            flat = {
              ...row,
              username: row.customer?.username ?? null,
              email: row.customer?.email ?? null,
            };
          return headers.map((key) => csvCell(flat[key])).join(',');
        })
        .join('\r\n')
    );
  }
}
