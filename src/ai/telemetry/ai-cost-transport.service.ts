import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AiCostCall } from '../../mongo/models.js';
import { isUniqueViolation } from '../../mongo/errors.js';
import { aiCostContext } from './ai-cost-context.js';
import {
  CostObservation,
  CostResponseParser,
  metadataText,
} from './cost-observation.js';

@Injectable()
export class AiCostTransportService {
  private readonly logger = new Logger(AiCostTransportService.name);
  constructor(
    @InjectModel(AiCostCall.name) private readonly calls: Model<AiCostCall>,
  ) {}

  forModel(model: string, feature = 'SYSTEM'): typeof fetch {
    return (input, init) => this.observe(input, init, fetch, model, feature);
  }
  readonly fetch: typeof fetch = (input, init) =>
    this.observe(input, init, fetch);

  /** The underlying function is supplied in tests; production always uses native fetch. */
  async observe(
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
    underlying: typeof fetch,
    model = 'unknown',
    feature = 'SYSTEM',
  ): Promise<Response> {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    // A provider's fetch hook can serve other hosts; never record credentials or arbitrary URLs.
    if (
      url.hostname !== 'openrouter.ai' ||
      !/^\/api\/(?:v1|alpha)\//.test(url.pathname)
    )
      return underlying(input, init);
    const operation = /\/embeddings$/.test(url.pathname)
      ? 'EMBEDDING'
      : /\/rerank$/.test(url.pathname)
        ? 'RERANK'
        : /\/(?:decisions|evaluations)$/.test(url.pathname)
          ? 'MODERATION'
          : /\/images(?:\/|$)/.test(url.pathname)
            ? 'IMAGE'
            : /\/transcriptions$/.test(url.pathname)
              ? 'TRANSCRIPTION'
              : 'CHAT';
    const scope = aiCostContext.getStore();
    const bodyModel =
      typeof init?.body === 'string'
        ? /"model"\s*:\s*"([^"\\]{1,200})"/.exec(init.body)?.[1]
        : null;
    const id = randomUUID();
    const startedAt = new Date();
    const entry = {
      _id: id,
      startedAt,
      executionId: scope?.executionId ?? randomUUID(),
      turnId: scope?.turnId ?? randomUUID(),
      userId: scope?.userId ?? null,
      feature: scope?.feature ?? feature,
      operation,
      requestedModel:
        metadataText(bodyModel) ?? metadataText(model) ?? 'unknown',
    };
    let recorded = false;
    try {
      await this.calls.create(entry);
      recorded = true;
    } catch {
      this.logger.error(
        'AI_COST_WRITE_FAILED: attempt could not be recorded; billing coverage is incomplete',
      );
    }
    let response: Response;
    try {
      response = await underlying(input, init);
    } catch (error) {
      await this.finish(
        id,
        recorded,
        new CostObservation(),
        init?.signal?.aborted ? 'ABORTED' : 'FAILED',
        null,
      );
      throw error;
    }
    const parser = new CostResponseParser(
      response.headers.get('content-type')?.includes('text/event-stream') ??
        false,
    );
    let settled = false;
    const settle = async (status: AiCostCall['status']) => {
      if (settled) return;
      settled = true;
      parser.finish();
      await this.finish(
        id,
        recorded,
        parser.observation,
        parser.observation.failed || !response.ok ? 'FAILED' : status,
        response.status,
      );
    };
    if (!response.body) {
      await settle(response.ok ? 'SUCCEEDED' : 'FAILED');
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await reader.read();
          if (item.done) {
            await settle('SUCCEEDED');
            controller.close();
          } else {
            parser.write(item.value);
            controller.enqueue(item.value);
          }
        } catch (error) {
          await settle(init?.signal?.aborted ? 'ABORTED' : 'FAILED');
          controller.error(error);
        }
      },
      async cancel(reason) {
        await settle('ABORTED');
        await reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  async settleCharge(
    id: string,
    observation: CostObservation,
    source: 'RESPONSE' | 'GENERATION',
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const {
      generationId,
      resolvedModel,
      provider,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedTokens,
    } = observation;
    // chargeKey is assigned only with a reported cost; a later attempt can supply missing cost.
    const chargeKey =
      observation.costUsd !== null && generationId
        ? `openrouter:${generationId}`
        : undefined;
    const values = {
      generationId,
      resolvedModel,
      provider,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedTokens,
      costUsd:
        observation.costUsd === null
          ? null
          : Types.Decimal128.fromString(observation.costUsd),
      costSource: observation.costUsd === null ? null : source,
      ...extra,
      ...(chargeKey ? { chargeKey } : {}),
    };
    try {
      await this.calls.updateOne({ _id: id }, { $set: values }).exec();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Retain the attempt but count a provider generation's reported charge just once.
      const { chargeKey: _chargeKey, ...duplicateValues } = values;
      await this.calls
        .updateOne(
          { _id: id },
          {
            $set: {
              ...duplicateValues,
              costUsd: null,
              costSource: null,
              duplicateCharge: true,
            },
            $unset: { chargeKey: 1 },
          },
        )
        .exec();
    }
  }
  private async finish(
    id: string,
    recorded: boolean,
    observation: CostObservation,
    status: AiCostCall['status'],
    httpStatus: number | null,
  ) {
    if (!recorded) return;
    try {
      await this.settleCharge(id, observation, 'RESPONSE', {
        status,
        httpStatus,
        finishedAt: new Date(),
      });
    } catch {
      this.logger.error(
        'AI_COST_WRITE_FAILED: attempt remains pending; reconcile with provider activity',
      );
    }
  }
}
