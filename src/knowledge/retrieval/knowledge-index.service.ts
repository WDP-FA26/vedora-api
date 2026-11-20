import { runtimeConfig } from '../../config/runtime-config.js';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chunkdown } from 'chunkdown';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { QdrantService } from '../../qdrant/qdrant.service.js';
import type { ExtractedSection } from '../extractors/document-extractor.js';

type IndexedSection = Pick<ExtractedSection, 'text' | 'images'>;
import {
  BM25_FOLDED_VECTOR,
  BM25_VECTOR,
  bm25,
  DENSE_VECTOR,
  type KnowledgePointPayload,
} from './knowledge-collection.js';
import {
  documentText,
  KnowledgeModelsService,
} from './knowledge-models.service.js';

const CHUNK_CHARS = runtimeConfig.KNOWLEDGE_CHUNK_MAX_CHARS;
const UPSERT_BATCH = runtimeConfig.KNOWLEDGE_UPSERT_BATCH_SIZE;

interface IndexedDocument {
  id: string;
  title: string;
  /** Tags every point, so one run's points can be told from another's. */
  runId: string;
}

@Injectable()
export class KnowledgeIndexService {
  private readonly logger = new Logger(KnowledgeIndexService.name);
  private readonly splitter = chunkdown({
    chunkSize: CHUNK_CHARS,
    maxOverflowRatio: 1.5,
  });
  readonly collection: string;
  private collectionReady: Promise<void> | null = null;

  constructor(
    private readonly qdrant: QdrantService,
    private readonly models: KnowledgeModelsService,
    configService: ConfigService,
  ) {
    this.collection = configService.get<string>(
      'QDRANT_COLLECTION',
      'vedora_knowledge',
    );
  }

  async index(
    document: IndexedDocument,
    sections: IndexedSection[],
  ): Promise<number> {
    await this.ensureCollection();
    const chunks: { page: number; text: string }[] = [];
    let previousHeading: string | null = null;
    sections.forEach(({ text }, index) => {
      const pageHeadings = headingsOf(text);
      for (const chunk of this.splitter.split(text).chunks) {
        const context = chunk.breadcrumbs.map((heading) => heading.text);
        if (context.length === 0 && !hasHeading(chunk.text)) {
          const fallback = fallbackHeading(
            chunk.text,
            pageHeadings,
            previousHeading,
          );
          if (fallback) context.push(fallback);
        }
        chunks.push({
          page: index + 1,
          text: [...context, chunk.text].join('\n'),
        });
      }
      previousHeading = pageHeadings.at(-1) ?? previousHeading;
    });
    const images = sections.flatMap(({ text, images }, index) =>
      images.map((jpeg) => ({ page: index + 1, jpeg, text })),
    );

    const [chunkVectors, imageVectors] = await Promise.all([
      this.models.embed(
        chunks.map(({ text }) => documentText(document.title, text)),
      ),
      this.models.embed(images.map(({ jpeg }) => ({ image: jpeg }))),
    ]);

    const points = [
      ...chunks.map(({ page, text }, index) => ({
        id: randomUUID(),
        vector: {
          [DENSE_VECTOR]: chunkVectors[index],
          [BM25_VECTOR]: bm25(text, false),
          [BM25_FOLDED_VECTOR]: bm25(text, true),
        },
        payload: payload(document, page, 'text', text),
      })),
      ...images.map(({ page, text }, index) => ({
        id: randomUUID(),
        vector: { [DENSE_VECTOR]: imageVectors[index] },
        payload: payload(document, page, 'image', text),
      })),
    ];

    // Clear only what this run may have written before (a retry), never
    // another run's points: the run that finishes current cleans up the rest.
    await this.removeRun(document.id, document.runId);
    for (let start = 0; start < points.length; start += UPSERT_BATCH) {
      await this.qdrant.upsert(this.collection, {
        wait: true,
        points: points.slice(start, start + UPSERT_BATCH),
      });
    }
    return images.length;
  }

  /** Deletes the points one indexing run wrote. */
  async removeRun(documentId: string, runId: string): Promise<void> {
    await this.ensureCollection();
    await this.qdrant.delete(this.collection, {
      wait: true,
      filter: {
        must: [
          { key: 'documentId', match: { value: documentId } },
          { key: 'runId', match: { value: runId } },
        ],
      },
    });
  }

  /** Deletes the document's points written by any run but `runId`. */
  async removeOtherRuns(documentId: string, runId: string): Promise<void> {
    await this.ensureCollection();
    await this.qdrant.delete(this.collection, {
      wait: true,
      filter: {
        must: [{ key: 'documentId', match: { value: documentId } }],
        must_not: [{ key: 'runId', match: { value: runId } }],
      },
    });
  }

  async remove(documentId: string): Promise<void> {
    await this.ensureCollection();
    await this.qdrant.delete(this.collection, {
      wait: true,
      filter: { must: [{ key: 'documentId', match: { value: documentId } }] },
    });
  }

  private ensureCollection(): Promise<void> {
    this.collectionReady ??= this.createCollection().catch((error: unknown) => {
      this.collectionReady = null;
      throw error;
    });
    return this.collectionReady;
  }

  private async createCollection(): Promise<void> {
    const size = this.models.dimensions;
    if ((await this.qdrant.collectionExists(this.collection)).exists) {
      const { config } = await this.qdrant.getCollection(this.collection);
      const vectors = config.params.vectors;
      const dense =
        vectors && !('size' in vectors) ? vectors[DENSE_VECTOR] : undefined;
      if (dense?.size !== size) {
        throw new Error(
          `Qdrant collection ${this.collection} does not hold ${size}-dimension "${DENSE_VECTOR}" vectors; index into a new QDRANT_COLLECTION`,
        );
      }
      return;
    }
    await this.qdrant.createCollection(this.collection, {
      vectors: { [DENSE_VECTOR]: { size, distance: 'Cosine', on_disk: true } },
      sparse_vectors: {
        [BM25_VECTOR]: { modifier: 'idf' },
        [BM25_FOLDED_VECTOR]: { modifier: 'idf' },
      },
      quantization_config: { scalar: { type: 'int8', always_ram: true } },
    });
    await this.qdrant.createPayloadIndex(this.collection, {
      field_name: 'documentId',
      field_schema: 'keyword',
      wait: true,
    });
    this.logger.log(`Created Qdrant collection ${this.collection}`);
  }
}

/**
 * The page's headings as Markdown parses them: ATX (`# Sắt`, closing hashes
 * dropped but `C#` kept) and setext (`Canxi` over `===`), never a `#` line
 * inside a code block.
 */
function headingsOf(markdown: string): string[] {
  const headings: string[] = [];
  for (const node of fromMarkdown(markdown).children) {
    if (node.type !== 'heading') continue;
    const text = toString(node).trim();
    if (text !== '') headings.push(text);
  }
  return headings;
}

function hasHeading(markdown: string): boolean {
  return headingsOf(markdown).length > 0;
}

/**
 * The heading an orphan chunk (no heading above it on its page) belongs to.
 * OCR often lifts a table above the text of its page, so a table takes the
 * page's first heading; other chunks continue the previous page's last one.
 */
function fallbackHeading(
  chunk: string,
  pageHeadings: string[],
  previousHeading: string | null,
): string | null {
  const isTable = chunk.trimStart().startsWith('|');
  if (isTable) return pageHeadings[0] ?? previousHeading;
  return previousHeading;
}

function payload(
  document: IndexedDocument,
  page: number,
  kind: KnowledgePointPayload['kind'],
  text: string,
): KnowledgePointPayload {
  return {
    documentId: document.id,
    title: document.title,
    page,
    kind,
    text,
    runId: document.runId,
  };
}
