import type {
  EmbeddingModelV4Middleware,
  RerankingModelV4,
  TranscriptionModelV4,
} from '@ai-sdk/provider';
import type { OpenRouter } from '@openrouter/sdk';
import { asRecord } from '../provider-shared.js';
import { createOpenRouterClient } from './openrouter.client.js';

type ContentPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { fileUri: string; mimeType: string } };

type OpenRouterEmbeddingPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; imageUrl: { url: string } };

function isContentPart(value: unknown): value is ContentPart {
  const part = asRecord(value);
  if (!part) return false;
  if (typeof part.text === 'string') return true;
  const inline = asRecord(part.inlineData);
  if (inline)
    return (
      typeof inline.mimeType === 'string' && typeof inline.data === 'string'
    );
  return asRecord(part.fileData) !== undefined;
}

function multimodalContent(
  options: Record<string, unknown> | undefined,
): (ContentPart[] | null)[] | undefined {
  const content = asRecord(options?.google)?.content;
  if (!Array.isArray(content)) return undefined;
  const values: (ContentPart[] | null)[] = [];
  for (const entry of content) {
    if (entry === null) {
      values.push(null);
      continue;
    }
    if (!Array.isArray(entry) || !entry.every(isContentPart))
      throw new Error('providerOptions.google.content has an invalid part');
    values.push(entry);
  }
  return values;
}

function openRouterPart(part: ContentPart): OpenRouterEmbeddingPart {
  if ('text' in part) return { type: 'text', text: part.text };
  if ('inlineData' in part) {
    const { mimeType, data } = part.inlineData;
    return {
      type: 'image_url',
      imageUrl: { url: `data:${mimeType};base64,${data}` },
    };
  }
  throw new Error('OpenRouter embeddings take inline data, not file URIs');
}

export function multimodalEmbeddingMiddleware(
  apiKey: string,
  modelId: string,
  dimensions: number,
  customFetch?: typeof fetch,
): EmbeddingModelV4Middleware {
  return {
    specificationVersion: 'v4',
    wrapEmbed: async ({ doEmbed, params }) => {
      const content = multimodalContent(params.providerOptions);
      if (!content) return doEmbed();
      if (content.length !== params.values.length)
        throw new Error(
          `google.content has ${content.length} entries for ${params.values.length} values`,
        );
      const input = params.values.map((value, index) => {
        const parts: OpenRouterEmbeddingPart[] = [];
        if (value) parts.push({ type: 'text', text: value });
        for (const part of content[index] ?? [])
          parts.push(openRouterPart(part));
        return { content: parts };
      });
      const client = createOpenRouterClient(apiKey, customFetch);
      const response = await client.embeddings.generate(
        {
          requestBody: {
            model: modelId,
            dimensions,
            encodingFormat: 'float',
            input,
          },
        },
        { signal: params.abortSignal },
      );
      if (typeof response === 'string')
        throw new Error('Embeddings returned a stream instead of vectors');
      const embeddings: number[][] = new Array<number[]>(input.length);
      response.data.forEach(({ embedding, index }, position) => {
        if (typeof embedding === 'string')
          throw new Error(
            'Embeddings returned base64 although floats were requested',
          );
        embeddings[index ?? position] = embedding;
      });
      return { embeddings, warnings: [] };
    },
  };
}

export function openRouterRerankingModel(
  client: OpenRouter,
  modelId: string,
): RerankingModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'openrouter.reranking',
    modelId,
    async doRerank({ documents, query, topN, abortSignal }) {
      const values =
        documents.type === 'text'
          ? documents.values
          : documents.values.map((value) => JSON.stringify(value));
      const response = await client.rerank.rerank(
        { requestBody: { model: modelId, query, documents: values, topN } },
        { signal: abortSignal },
      );
      if (typeof response === 'string')
        throw new Error('Rerank returned a stream instead of results');
      return {
        ranking: response.results.map(({ index, relevanceScore }) => ({
          index,
          relevanceScore,
        })),
      };
    },
  };
}

const AUDIO_FORMATS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
};

export function openRouterTranscriptionModel(
  client: OpenRouter,
  modelId: string,
): TranscriptionModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'openrouter.transcription',
    modelId,
    async doGenerate({ audio, mediaType, abortSignal }) {
      const format = AUDIO_FORMATS[mediaType];
      if (!format) throw new Error(`Unsupported audio type ${mediaType}`);
      const data =
        typeof audio === 'string'
          ? audio
          : Buffer.from(audio).toString('base64');
      const result = await client.stt.createTranscription(
        {
          sttRequest: {
            model: modelId,
            inputAudio: { data, format },
            responseFormat: 'verbose_json',
            timestampGranularities: ['word'],
            temperature: 0,
          },
        },
        { signal: abortSignal },
      );
      const words = (result.words ?? []).map(({ word, start, end }) => ({
        text: word,
        startSecond: start,
        endSecond: end,
      }));
      const segments = (result.segments ?? []).map(({ text, start, end }) => ({
        text,
        startSecond: start,
        endSecond: end,
      }));
      return {
        text: result.text,
        segments: segments.length > 0 ? segments : words,
        ...(words.length > 0 ? { words } : {}),
        language: result.language,
        durationInSeconds: result.duration,
        warnings: [],
        response: { timestamp: new Date(), modelId },
      };
    },
  };
}
