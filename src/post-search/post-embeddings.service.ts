import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { parsePayload, validatePayload } from '../common/validation';

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const BATCH = 64;
const TIMEOUT_MS = 30_000;

class EmbeddingDto {
  @IsOptional()
  @IsInt()
  index?: number;

  @IsArray()
  @IsNumber({}, { each: true })
  embedding!: number[];
}

class EmbeddingsResponseDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EmbeddingDto)
  data!: EmbeddingDto[];
}

class ErrorDetailDto {
  @IsString()
  message!: string;
}

class ErrorBodyDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ErrorDetailDto)
  error?: ErrorDetailDto;
}

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
    const json: unknown = await response.json();
    if (!response.ok) {
      const message = validatePayload(ErrorBodyDto, json).value?.error?.message;
      throw new Error(
        `OpenRouter /embeddings failed (${response.status}): ${message ?? 'no message'}`,
      );
    }
    return parsePayload(EmbeddingsResponseDto, json)
      .data.map((item, position) => ({
        ...item,
        index: item.index ?? position,
      }))
      .sort((a, b) => a.index - b.index)
      .map(({ embedding }) => embedding);
  }
}
