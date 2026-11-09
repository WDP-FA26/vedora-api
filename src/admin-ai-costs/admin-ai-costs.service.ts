import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import type { Model } from 'mongoose';
import { AiCostCall } from '../mongo/models.js';
import { resolveDashboardRange } from '../admin-dashboard/dashboard-range.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { AiCostTransportService } from '../ai/telemetry/ai-cost-transport.service.js';
import { CostObservation } from '../ai/telemetry/cost-observation.js';
import type {
  AiCostCallsQueryDto,
  AiCostQueryDto,
} from './ai-cost-query.dto.js';

const known = {
  $and: [{ $ne: ['$costUsd', null] }, { $ne: ['$duplicateCharge', true] }],
};
const unknown = {
  $and: [{ $eq: ['$costUsd', null] }, { $ne: ['$duplicateCharge', true] }],
};
const sumIf = (condition: unknown) => ({ $sum: { $cond: [condition, 1, 0] } });
const metrics = {
  calls: { $sum: 1 },
  knownCalls: sumIf(known),
  unknownCalls: sumIf(unknown),
  duplicateCalls: sumIf({ $eq: ['$duplicateCharge', true] }),
  pendingCalls: sumIf({ $eq: ['$status', 'PENDING'] }),
  failedCalls: sumIf({ $in: ['$status', ['FAILED', 'ABORTED']] }),
  knownSpendUsd: { $sum: { $cond: [known, '$costUsd', 0] } },
  inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
  outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
  reasoningTokens: { $sum: { $ifNull: ['$reasoningTokens', 0] } },
  cachedTokens: { $sum: { $ifNull: ['$cachedTokens', 0] } },
  unknownTokenCalls: sumIf({
    $or: [{ $eq: ['$inputTokens', null] }, { $eq: ['$outputTokens', null] }],
  }),
};
interface Metrics {
  calls: number;
  knownCalls: number;
  unknownCalls: number;
  duplicateCalls: number;
  pendingCalls: number;
  failedCalls: number;
  knownSpendUsd: { toString(): string } | number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  unknownTokenCalls: number;
}
const empty: Metrics = {
  calls: 0,
  knownCalls: 0,
  unknownCalls: 0,
  duplicateCalls: 0,
  pendingCalls: 0,
  failedCalls: 0,
  knownSpendUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  unknownTokenCalls: 0,
};
const publicMetrics = (m: Metrics) => ({
  ...m,
  knownSpendUsd: m.knownSpendUsd.toString(),
});
const csvCell = (value: unknown) => {
  const string =
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
      ? String(value)
      : '';
  return (
    '"' +
    (/^[=+\-@\t\r\n]/.test(string) ? "'" + string : string).replaceAll(
      '"',
      '""',
    ) +
    '"'
  );
};

@Injectable()
export class AdminAiCostsService {
  constructor(
    @InjectModel(AiCostCall.name) private readonly calls: Model<AiCostCall>,
    private readonly transport: AiCostTransportService,
    private readonly config: ConfigService,
  ) {}
  private filter(query: AiCostQueryDto) {
    const range = resolveDashboardRange(query);
    return {
      range,
      match: {
        startedAt: { $gte: range.start, $lt: range.endExclusive },
        ...(query.feature ? { feature: query.feature } : {}),
        ...(query.model
          ? {
              $expr: {
                $eq: [
                  { $ifNull: ['$resolvedModel', '$requestedModel'] },
                  { $literal: query.model },
                ],
              },
            }
          : {}),
      },
    };
  }
  async report(query: AiCostQueryDto) {
    const { range, match } = this.filter(query);
    type Group = Metrics & {
      _id: { model: string; feature: string; operation: string };
    };
    const totalsPromise = this.calls
      .aggregate<{
        summary: Metrics[];
        daily: (Metrics & { _id: string })[];
        groups: Group[];
      }>([
        { $match: match },
        {
          $facet: {
            summary: [
              { $group: { _id: null, ...metrics } },
              { $project: { _id: 0 } },
            ],
            daily: [
              {
                $group: {
                  _id: {
                    $dateToString: {
                      date: '$startedAt',
                      format: '%Y-%m-%d',
                      timezone: 'Asia/Bangkok',
                    },
                  },
                  ...metrics,
                },
              },
              { $sort: { _id: 1 } },
            ],
            groups: [
              {
                $group: {
                  _id: {
                    model: { $ifNull: ['$resolvedModel', '$requestedModel'] },
                    feature: '$feature',
                    operation: '$operation',
                  },
                  ...metrics,
                },
              },
              { $sort: { knownSpendUsd: -1, '_id.model': 1 } },
              { $limit: 100 },
            ],
          },
        },
      ])
      .exec();
    const turnsPromise = this.calls
      .aggregate<{
        count: { total: number; fullyPriced: number }[];
        stats: { mean: { toString(): string } }[];
        p95: { cost: { toString(): string } }[];
        expensive: {
          _id: string;
          userId: string | null;
          feature: string;
          cost: { toString(): string };
          calls: number;
          unknown: number;
          pending: number;
        }[];
      }>([
        { $match: match },
        {
          $group: {
            _id: '$turnId',
            userId: { $first: '$userId' },
            feature: { $first: '$feature' },
            cost: metrics.knownSpendUsd,
            known: metrics.knownCalls,
            calls: { $sum: 1 },
            unknown: sumIf(unknown),
            pending: metrics.pendingCalls,
          },
        },
        {
          $facet: {
            count: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  fullyPriced: sumIf({
                    $and: [
                      { $eq: ['$unknown', 0] },
                      { $eq: ['$pending', 0] },
                      { $gt: ['$known', 0] },
                    ],
                  }),
                },
              },
            ],
            stats: [
              { $match: { unknown: 0, pending: 0, known: { $gt: 0 } } },
              { $group: { _id: null, mean: { $avg: '$cost' } } },
            ],
            p95: [
              { $match: { unknown: 0, pending: 0, known: { $gt: 0 } } },
              {
                $setWindowFields: {
                  sortBy: { cost: 1 },
                  output: {
                    rank: { $documentNumber: {} },
                    total: {
                      $count: {},
                      window: { documents: ['unbounded', 'unbounded'] },
                    },
                  },
                },
              },
              {
                $match: {
                  $expr: {
                    $eq: ['$rank', { $ceil: { $multiply: ['$total', 0.95] } }],
                  },
                },
              },
              { $project: { cost: 1 } },
            ],
            expensive: [{ $sort: { cost: -1, _id: 1 } }, { $limit: 20 }],
          },
        },
      ])
      .exec();
    const [[result], [turns]] = await Promise.all([
      totalsPromise,
      turnsPromise,
    ]);
    const counts = turns?.count[0] ?? { total: 0, fullyPriced: 0 };
    const { start: _start, endExclusive: _end, ...publicRange } = range;
    return {
      generatedAt: new Date().toISOString(),
      range: publicRange,
      currency: 'USD' as const,
      scope: 'MATCHED_CALLS' as const,
      summary: {
        ...publicMetrics(result.summary[0] ?? empty),
        turns: counts.total,
        fullyPricedTurns: counts.fullyPriced,
        meanKnownTurnUsd: turns?.stats[0]?.mean.toString() ?? null,
        p95KnownTurnUsd: turns?.p95[0]?.cost.toString() ?? null,
      },
      daily: result.daily.map(({ _id, ...row }) => ({
        date: _id,
        ...publicMetrics(row),
      })),
      groups: result.groups.map(({ _id, ...row }) => ({
        ..._id,
        ...publicMetrics(row),
      })),
      groupsLimit: 100,
      expensiveTurns: (turns?.expensive ?? []).map(({ _id, cost, ...row }) => ({
        turnId: _id,
        knownSpendUsd: cost.toString(),
        ...row,
      })),
    };
  }
  private row(row: AiCostCall) {
    return {
      id: row.id,
      turnId: row.turnId,
      executionId: row.executionId,
      userId: row.userId,
      feature: row.feature,
      operation: row.operation,
      requestedModel: row.requestedModel,
      resolvedModel: row.resolvedModel,
      provider: row.provider,
      generationId: row.generationId,
      status: row.status,
      httpStatus: row.httpStatus,
      costUsd: row.costUsd?.toString() ?? null,
      costSource: row.costSource,
      duplicateCharge: row.duplicateCharge,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens,
      cachedTokens: row.cachedTokens,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      reconciledAt: row.reconciledAt?.toISOString() ?? null,
    };
  }
  async list(query: AiCostCallsQueryDto) {
    const { match } = this.filter(query);
    const [rows, total] = await Promise.all([
      this.calls
        .find(match)
        .sort({ startedAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.calls.countDocuments(match).exec(),
    ]);
    return {
      items: rows.map((row) => this.row(row)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }
  async csv(query: AiCostQueryDto): Promise<string> {
    const rows = await this.calls
      .find(this.filter(query).match)
      .sort({ startedAt: -1, _id: -1 })
      .limit(10001)
      .exec();
    if (rows.length > 10000)
      throw new InvalidInputException(
        'BAD_REQUEST',
        'CSV exceeds 10000 calls; narrow the date/model/feature filter',
      );
    const headers = [
      'id',
      'turnId',
      'executionId',
      'userId',
      'feature',
      'operation',
      'requestedModel',
      'resolvedModel',
      'provider',
      'generationId',
      'status',
      'httpStatus',
      'costUsd',
      'costSource',
      'duplicateCharge',
      'inputTokens',
      'outputTokens',
      'reasoningTokens',
      'cachedTokens',
      'startedAt',
      'finishedAt',
      'reconciledAt',
    ] as const;
    return (
      '\ufeff' +
      headers.map(csvCell).join(',') +
      '\r\n' +
      rows
        .map((row) => {
          const value = this.row(row);
          return headers.map((key) => csvCell(value[key])).join(',');
        })
        .join('\r\n')
    );
  }
  async reconcile(id: string) {
    const row = await this.calls.findById(id).exec();
    if (!row)
      throw new ResourceNotFoundException('NOT_FOUND', 'AI call not found');
    if (row.costUsd !== null || row.duplicateCharge) return this.row(row);
    if (!row.generationId)
      throw new StateConflictException(
        'CONFLICT',
        'Provider generation ID is unavailable; reconcile through provider activity',
      );
    if (
      row.status === 'PENDING' &&
      Date.now() - row.startedAt.getTime() < 15 * 60_000
    )
      throw new StateConflictException(
        'CONFLICT',
        'This attempt may still be running',
      );
    const apiKey = this.config.getOrThrow<string>('OPENROUTER_API_KEY');
    let data: Record<string, unknown>;
    try {
      const response = await fetch(
        `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(row.generationId)}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw new Error('Provider lookup unavailable');
      const json = (await response.json()) as {
        data?: Record<string, unknown>;
      };
      data = json.data ?? {};
    } catch {
      throw new FeatureUnavailableException(
        'SERVICE_UNAVAILABLE',
        'Provider generation lookup unavailable; retry later',
      );
    }
    if (data.id !== row.generationId)
      throw new FeatureUnavailableException(
        'SERVICE_UNAVAILABLE',
        'Provider returned mismatched generation ID',
      );
    const observation = new CostObservation();
    observation.accept({
      id: row.generationId,
      model: data.model ?? row.resolvedModel,
      provider: data.provider_name ?? row.provider,
      usage: {
        cost: data.total_cost,
        prompt_tokens: data.native_tokens_prompt,
        completion_tokens: data.native_tokens_completion,
        completion_tokens_details: {
          reasoning_tokens: data.native_tokens_reasoning,
        },
        prompt_tokens_details: { cached_tokens: data.native_tokens_cached },
      },
    });
    if (observation.costUsd === null)
      throw new FeatureUnavailableException(
        'SERVICE_UNAVAILABLE',
        'Provider has not reported a final cost',
      );
    await this.transport.settleCharge(row.id, observation, 'GENERATION', {
      reconciledAt: new Date(),
    });
    return this.row((await this.calls.findById(id).exec())!);
  }
}
