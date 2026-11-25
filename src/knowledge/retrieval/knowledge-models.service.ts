import { runtimeConfig } from '../../config/runtime-config.js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '@nestjs/ai';
import type { RerankingModelV4 } from '@ai-sdk/provider';
import { generateText, rerank } from 'ai';
import { AiCostTransportService } from '../../ai/telemetry/ai-cost-transport.service.js';
import { aiFailure } from '../../ai/provider-failure.js';
import type { ChatModel } from '../../ai/providers/ai-provider.interface.js';
import {
  aiModels,
  modelIdFor,
  providerDialect,
} from '../../ai/providers/provider-registry.js';

type EmbeddingInput = string | { image: Uint8Array };

export interface RerankResult {
  index: number;
  relevanceScore: number;
}

const IMAGE_BATCH = runtimeConfig.KNOWLEDGE_IMAGE_BATCH_SIZE;
const EMBED_TIMEOUT_MS = runtimeConfig.KNOWLEDGE_EMBED_TIMEOUT_MS;
const OCR_TIMEOUT_MS = runtimeConfig.KNOWLEDGE_OCR_TIMEOUT_MS;
const OCR_CONCURRENCY = runtimeConfig.KNOWLEDGE_OCR_CONCURRENCY;
const OCR_MAX_OUTPUT_TOKENS = runtimeConfig.KNOWLEDGE_OCR_MAX_OUTPUT_TOKENS;

const OCR_INSTRUCTIONS =
  'Transcribe every piece of text on this PDF page exactly as written, in reading order, as Markdown: headings as headings, lists as lists, tables as Markdown tables. Use plain Unicode symbols (e.g. ≥, ≤, μg, α) instead of LaTeX math wrappers. Do not translate, summarize, correct, describe images/figures/charts/logos/blank areas, or emit image placeholders (such as ![...] or [Image: ...]); keep only actual printed text and captions. Output only the page text; output nothing if the page has no text.';

@Injectable()
export class KnowledgeModelsService {
  private readonly rerankModel: RerankingModelV4 | null;
  private readonly ocrModel: ChatModel;
  readonly dimensions: number;

  constructor(
    configService: ConfigService,
    private readonly ai: AiService,
    costs: AiCostTransportService,
  ) {
    const models = aiModels(configService);
    const rerankModelId = modelIdFor(configService, 'rerank');
    this.rerankModel = configService.get<boolean>(
      'KNOWLEDGE_RERANK_ENABLED',
      true,
    )
      ? models.reranking(rerankModelId, {
          fetch: costs.forModel(rerankModelId),
        })
      : null;
    const ocrModelId = modelIdFor(configService, 'ocr');
    this.ocrModel = models.chat(ocrModelId, {
      effort: 'none',
      fetch: costs.forModel(ocrModelId),
    });
    this.dimensions = configService.get<number>(
      'KNOWLEDGE_EMBEDDING_DIMENSIONS',
      1536,
    );
  }

  async embed(inputs: EmbeddingInput[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    if (inputs.every((input): input is string => typeof input === 'string')) {
      const { embeddings } = await this.ai.embedMany({
        label: 'index-knowledge',
        values: inputs,
      });
      return embeddings;
    }
    // One request per batch: `google.content` must line up with the values of that request.
    const vectors: number[][] = [];
    for (let start = 0; start < inputs.length; start += IMAGE_BATCH) {
      vectors.push(
        ...(await this.embedBatch(
          inputs.slice(start, start + IMAGE_BATCH),
          AbortSignal.timeout(EMBED_TIMEOUT_MS),
        )),
      );
    }
    return vectors;
  }

  async embedQuery(query: string, signal?: AbortSignal): Promise<number[]> {
    const { embedding } = await this.ai.embed({
      label: 'search-knowledge',
      value: `task: question answering | query: ${query}`,
      abortSignal: signal,
    });
    return embedding;
  }

  async rerank(
    query: string,
    documents: string[],
    topN: number,
    signal: AbortSignal,
  ): Promise<RerankResult[] | null> {
    if (!this.rerankModel || !documents.length) return null;
    try {
      const { ranking } = await rerank({
        model: this.rerankModel,
        query,
        documents,
        topN,
        abortSignal: signal,
        maxRetries: 0,
      });
      return ranking.map(({ originalIndex, score }) => ({
        index: originalIndex,
        relevanceScore: score,
      }));
    } catch (error) {
      throw aiFailure('Rerank', error);
    }
  }

  /** The text of each page, read by the OCR model one page at a time. */
  async ocrPdf(pdf: Uint8Array): Promise<string[]> {
    const pages = await splitPages(pdf);
    const signal = AbortSignal.timeout(OCR_TIMEOUT_MS);
    const texts: string[] = new Array<string>(pages.length);
    let next = 0;
    const worker = async () => {
      while (next < pages.length) {
        const index = next;
        next += 1;
        texts[index] = await this.ocrPage(pages[index], signal);
      }
    };
    const workers: Promise<void>[] = [];
    for (
      let count = 0;
      count < Math.min(OCR_CONCURRENCY, pages.length);
      count++
    )
      workers.push(worker());
    await Promise.all(workers);
    return texts;
  }

  private async ocrPage(
    page: Uint8Array,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const { text } = await generateText({
        model: this.ocrModel,
        system: OCR_INSTRUCTIONS,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                data: page,
                mediaType: 'application/pdf',
                filename: 'page.pdf',
              },
            ],
          },
        ],
        maxOutputTokens: OCR_MAX_OUTPUT_TOKENS,
        temperature: 0,
        providerOptions: providerDialect().pdfReading(),
        abortSignal: signal,
      });
      return cleanOcrText(text);
    } catch (error) {
      throw aiFailure('OCR', error);
    }
  }

  private async embedBatch(
    inputs: EmbeddingInput[],
    signal: AbortSignal,
  ): Promise<number[][]> {
    const values: string[] = [];
    const content: (
      { inlineData: { mimeType: string; data: string } }[] | null
    )[] = [];
    for (const input of inputs) {
      if (typeof input === 'string') {
        values.push(input);
        content.push(null);
        continue;
      }
      values.push('');
      content.push([
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: Buffer.from(input.image).toString('base64'),
          },
        },
      ]);
    }
    const { embeddings } = await this.ai.embedMany({
      label: 'index-knowledge-images',
      values,
      abortSignal: signal,
      // Gemini's multimodal embedding parts, which the AI SDK passes on per value.
      providerOptions: { google: { content } },
    });
    return embeddings;
  }
}

/** One single-page PDF per page, in order. */
async function splitPages(pdf: Uint8Array): Promise<Uint8Array[]> {
  const mupdf = await import('mupdf');
  const source = new mupdf.PDFDocument(pdf);
  try {
    const pages: Uint8Array[] = [];
    for (let index = 0; index < source.countPages(); index++) {
      const single = new mupdf.PDFDocument();
      try {
        single.graftPage(-1, source, index);
        pages.push(single.saveToBuffer('garbage,compress').asUint8Array());
      } finally {
        single.destroy();
      }
    }
    return pages;
  } finally {
    source.destroy();
  }
}

/** Drops a Markdown fence around the whole page and any image links. */
function cleanOcrText(text: string): string {
  const unfenced = text
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n?```$/, '');
  return unfenced.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
}

export function documentText(title: string, text: string): string {
  return `title: ${title} | text: ${text}`;
}
