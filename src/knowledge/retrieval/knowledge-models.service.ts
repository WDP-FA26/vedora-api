import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ClassConstructor } from 'class-transformer';
import { parsePayload, validatePayload } from '../../common/validation';
import {
  EmbeddingsResponse,
  OcrResponse,
  OpenRouterErrorBody,
  RerankResponse,
} from './openrouter.dto';

type EmbeddingInput = string | { image: Uint8Array };

export interface RerankResult {
  index: number;
  relevanceScore: number;
}

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const TEXT_BATCH = 64;
const IMAGE_BATCH = 8;
const EMBED_TIMEOUT_MS = 60_000;
const OCR_TIMEOUT_MS = 5 * 60_000;
// file-parser only runs inside a chat completion; this cheap model receives
// the parsed text and its reply is discarded
const OCR_CARRIER_MODEL = 'google/gemini-3.1-flash-lite';

// plain fetch: the AI SDK embeds text only, and @openrouter/sdk neither
// honours abort signals nor returns OCR annotations
@Injectable()
export class KnowledgeModelsService {
  private readonly apiKey: string;
  private readonly embeddingModel: string;
  private readonly rerankModel: string;
  readonly dimensions: number;

  constructor(configService: ConfigService) {
    this.apiKey = configService.getOrThrow<string>('OPENROUTER_API_KEY');
    this.embeddingModel = configService.get<string>(
      'OPENROUTER_EMBEDDING_MODEL',
      'google/gemini-embedding-2',
    );
    this.rerankModel = configService.get<string>('OPENROUTER_RERANK_MODEL', '');
    this.dimensions = configService.get<number>(
      'KNOWLEDGE_EMBEDDING_DIMENSIONS',
      1536,
    );
  }

  async embed(inputs: EmbeddingInput[]): Promise<number[][]> {
    const size = inputs.some((input) => typeof input !== 'string')
      ? IMAGE_BATCH
      : TEXT_BATCH;
    const vectors: number[][] = [];
    for (let start = 0; start < inputs.length; start += size) {
      vectors.push(
        ...(await this.embedBatch(
          inputs.slice(start, start + size),
          AbortSignal.timeout(EMBED_TIMEOUT_MS),
        )),
      );
    }
    return vectors;
  }

  async embedQuery(query: string, signal?: AbortSignal): Promise<number[]> {
    const [vector] = await this.embedBatch(
      [`task: question answering | query: ${query}`],
      signal ?? AbortSignal.timeout(EMBED_TIMEOUT_MS),
    );
    return vector;
  }

  async rerank(
    query: string,
    documents: string[],
    topN: number,
    signal: AbortSignal,
  ): Promise<RerankResult[] | null> {
    if (!this.rerankModel || !documents.length) return null;
    const { results } = await this.post(
      '/rerank',
      { model: this.rerankModel, query, documents, top_n: topN },
      RerankResponse,
      signal,
    );
    return results.map(({ index, relevance_score }) => ({
      index,
      relevanceScore: relevance_score,
    }));
  }

  async ocrPdf(pdf: Uint8Array): Promise<string[]> {
    const response = await this.fetch(
      '/chat/completions',
      {
        model: OCR_CARRIER_MODEL,
        max_tokens: 16,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '.' },
              {
                type: 'file',
                file: {
                  filename: 'document.pdf',
                  file_data: `data:application/pdf;base64,${Buffer.from(pdf).toString('base64')}`,
                },
              },
            ],
          },
        ],
        plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
      },
      AbortSignal.timeout(OCR_TIMEOUT_MS),
    );
    // a failed carrier completion still carries the parse
    const body = parsePayload(OcrResponse, await response.json());
    const annotations =
      body.choices?.[0]?.message.annotations ??
      body.error?.metadata?.file_annotations;
    if (!annotations?.length) {
      throw new Error(
        `OCR returned no parse (${response.status}): ${body.error?.message ?? 'no annotations'}`,
      );
    }
    return annotations[0].file.content
      .flatMap((part) =>
        part.type === 'text' && part.text !== undefined ? [part.text] : [],
      )
      .filter((text) => !/^\s*<\/?file\b/.test(text))
      .map((text) => text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim());
  }

  private async embedBatch(
    inputs: EmbeddingInput[],
    signal: AbortSignal,
  ): Promise<number[][]> {
    const { data } = await this.post(
      '/embeddings',
      {
        model: this.embeddingModel,
        dimensions: this.dimensions,
        encoding_format: 'float',
        input: inputs.map((input) => ({
          content: [
            typeof input === 'string'
              ? { type: 'text', text: input }
              : {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/jpeg;base64,${Buffer.from(input.image).toString('base64')}`,
                  },
                },
          ],
        })),
      },
      EmbeddingsResponse,
      signal,
    );
    return data
      .map((item, position) => ({
        embedding: item.embedding,
        index: item.index ?? position,
      }))
      .sort((a, b) => a.index - b.index)
      .map(({ embedding }) => embedding);
  }

  private async post<T extends object>(
    path: string,
    body: object,
    responseClass: ClassConstructor<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const response = await this.fetch(path, body, signal);
    const json: unknown = await response.json();
    if (!response.ok) {
      const message = validatePayload(OpenRouterErrorBody, json).value?.error
        ?.message;
      throw new Error(
        `OpenRouter ${path} failed (${response.status}): ${message ?? 'no message'}`,
      );
    }
    return parsePayload(responseClass, json);
  }

  private fetch(
    path: string,
    body: object,
    signal: AbortSignal,
  ): Promise<Response> {
    return fetch(`${OPENROUTER_API}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  }
}

export function documentText(title: string, text: string): string {
  return `title: ${title} | text: ${text}`;
}
