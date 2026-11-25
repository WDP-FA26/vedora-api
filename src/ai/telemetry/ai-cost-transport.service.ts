import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AiCostCall } from '../../mongo/models.js';
import { isUniqueViolation } from '../../mongo/errors.js';
import {
  ALL_PROVIDER_ADAPTERS,
  providerAdapter,
} from '../providers/provider-registry.js';
import { aiCostContext } from './ai-cost-context.js';
import {
  CostObservation,
  CostResponseParser,
  metadataText,
} from './cost-observation.js';

async function requestBodyText(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<string | null> {
  if (typeof init?.body === 'string') return init.body;
  if (init?.body !== undefined || !(input instanceof Request)) return null;
  return input.clone().text();
}

export type AiCostOperation =
  'CHAT' | 'EMBEDDING' | 'RERANK' | 'MODERATION' | 'IMAGE' | 'TRANSCRIPTION';

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  return new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url,
  );
}

export type AiBiller = AiCostCall['billedBy'];

/** The provider API a URL belongs to; null for any other host or path. */
function billerOf(target: URL): AiBiller | null {
  for (const adapter of ALL_PROVIDER_ADAPTERS) {
    const base = new URL(adapter.cost.baseUrl);
    const apiPath = base.pathname.replace(/\/$/, '');
    if (
      target.origin === base.origin &&
      target.pathname.startsWith(`${apiPath}/`)
    )
      return adapter.id;
  }
  return null;
}

/** What a call is for, from the OpenRouter or AI Gateway endpoint it goes to. */
function operationOf(target: URL): AiCostOperation {
  const path = target.pathname;
  if (path.endsWith('/embeddings') || path.endsWith('/embedding-model'))
    return 'EMBEDDING';
  if (path.endsWith('/rerank') || path.endsWith('/reranking-model'))
    return 'RERANK';
  if (/\/images(?:\/|$)/.test(path) || path.endsWith('/image-model'))
    return 'IMAGE';
  if (path.endsWith('/transcriptions') || path.endsWith('/transcription-model'))
    return 'TRANSCRIPTION';
  return 'CHAT';
}

@Injectable()
export class AiCostTransportService {
  private readonly logger = new Logger(AiCostTransportService.name);
  constructor(
    @InjectModel(AiCostCall.name) private readonly calls: Model<AiCostCall>,
  ) {}

  /**
   * A fetch that records each call under `model`. `operation` names what the
   * call is for when its URL cannot tell, such as a moderation call through the
   * chat API.
   */
  forModel(
    model: string,
    feature = 'SYSTEM',
    operation?: AiCostOperation,
  ): typeof fetch {
    return (input, init) =>
      this.observe(input, init, fetch, model, feature, operation);
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
    operation: AiCostOperation = operationOf(urlOf(input)),
  ): Promise<Response> {
    // A provider's fetch hook can serve other hosts; never record credentials or arbitrary URLs.
    const billedBy = billerOf(urlOf(input));
    if (!billedBy) return underlying(input, init);
    const scope = aiCostContext.getStore();
    // The OpenRouter SDK passes a Request with no init; fetch callers pass both.
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : null);
    const requestText = await requestBodyText(input, init);
    const bodyModel =
      requestText === null
        ? null
        : /"model"\s*:\s*"([^"\\]{1,200})"/.exec(requestText)?.[1];
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
      billedBy,
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
        billedBy,
        new CostObservation(),
        signal?.aborted ? 'ABORTED' : 'FAILED',
        null,
      );
      throw error;
    }
    const costAdapter = providerAdapter(billedBy).cost;
    const parser = new CostResponseParser(
      response.headers.get('content-type')?.includes('text/event-stream') ??
        false,
      (payload, observation) => costAdapter.parsePayload(payload, observation),
    );
    let settled = false;
    const settle = async (status: AiCostCall['status']) => {
      if (settled) return;
      settled = true;
      parser.finish();
      await this.finish(
        id,
        recorded,
        billedBy,
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
          await settle(signal?.aborted ? 'ABORTED' : 'FAILED');
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
    billedBy: AiBiller,
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
      cacheWriteTokens,
    } = observation;
    // chargeKey is assigned only with a reported cost; a later attempt can supply missing cost.
    const chargeKey =
      observation.costUsd !== null && generationId
        ? `${billedBy}:${generationId}`
        : undefined;
    const values = {
      generationId,
      resolvedModel,
      provider,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedTokens,
      cacheWriteTokens,
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
    billedBy: AiBiller,
    observation: CostObservation,
    status: AiCostCall['status'],
    httpStatus: number | null,
  ) {
    if (!recorded) return;
    try {
      await this.settleCharge(id, billedBy, observation, 'RESPONSE', {
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
