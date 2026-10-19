import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const BATCH = 64;
const TIMEOUT_MS = 30_000;

const errorBody = z.object({
  error: z.object({ message: z.string() }).optional(),
});
const embeddingsResponse = z.object({
  data: z.array(
    z.object({ index: z.number().optional(), embedding: z.array(z.number()) }),
  ),
});

/** Text embeddings for post search, through OpenRouter's embeddings API. */
@Injectable()
export class PostEmbeddingsService {
  private readonly apiKey: string;
  private readonly model: string;
  readonly dimensions: number;

  constructor(configService: ConfigService) {
    this.apiKey = configService.getOrThrow<string>('OPENROUTER_API_KEY');
    this.model = configService.get<string>(
      'POST_SEARCH_EMBEDDING_MODEL',
      'google/gemini-embedding-2',
    );
    this.dimensions = configService.get<number>(
      'POST_SEARCH_EMBEDDING_DIMENSIONS',
      768,
    );
  }

  /** Embeds post bodies, in input order. */
  async embedPosts(bodies: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let start = 0; start < bodies.length; start += BATCH) {
      vectors.push(
        ...(await this.embed(
          bodies
            .slice(start, start + BATCH)
            .map((body) => `title: none | text: ${body}`),
          AbortSignal.timeout(TIMEOUT_MS),
        )),
      );
    }
    return vectors;
  }

  async embedQuery(query: string, signal?: AbortSignal): Promise<number[]> {
    const [vector] = await this.embed(
      [`task: search result | query: ${query}`],
      signal ?? AbortSignal.timeout(TIMEOUT_MS),
    );
    return vector;
  }

  private async embed(
    inputs: string[],
    signal: AbortSignal,
  ): Promise<number[][]> {
    const response = await fetch(`${OPENROUTER_API}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        dimensions: this.dimensions,
        encoding_format: 'float',
        input: inputs,
      }),
      signal,
    });
    const json = z.json().parse(await response.json());
    if (!response.ok) {
      const message = errorBody.safeParse(json).data?.error?.message;
      throw new Error(
        `OpenRouter /embeddings failed (${response.status}): ${message ?? 'no message'}`,
      );
    }
    return embeddingsResponse
      .parse(json)
      .data.map((item, position) => ({
        ...item,
        index: item.index ?? position,
      }))
      .sort((a, b) => a.index - b.index)
      .map(({ embedding }) => embedding);
  }
}
