import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  KnowledgeDocument,
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
} from '@prisma/client';
import type { HandleUploadBody } from '@vercel/blob/client';
import { BlobService } from '../blob/blob.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateKnowledgeUploadResponseDto,
  KnowledgeDocumentResponseDto,
} from './dto/knowledge-document-response.dto';
import { PdfExtractor } from './extractors/pdf-extractor';
import { IngestionError, PDF_CONTENT_TYPE } from './ingestion';
import { KnowledgeIndexService } from './retrieval/knowledge-index.service';

/** Client tokens stop accepting the upload after this long. */
export const UPLOAD_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Knowledge-base files go straight from the browser to Vercel Blob:
 * `createUpload` accepts PDFs only, then creates the document row and a
 * client token scoped to its pathname and content type. Only Vercel
 * Blob's signed upload-completed callback (`handleCallback`) starts
 * ingestion; the browser is never trusted to say an upload finished.
 * `markUploaded` moves the row to PROCESSING exactly once (Vercel retries
 * callbacks), and `ingest` extracts the PDF and indexes the result into
 * Qdrant; every failure is an `IngestionError` whose reason lands on the
 * row. The maintenance cron fails documents that never complete.
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);
  private readonly maxBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly pdf: PdfExtractor,
    private readonly index: KnowledgeIndexService,
    configService: ConfigService,
  ) {
    this.maxBytes =
      configService.getOrThrow<number>('MAX_KNOWLEDGE_FILE_MB') * 1024 * 1024;
  }

  async createUpload(
    userId: string,
    filename: string,
    sizeBytes: number,
  ): Promise<CreateKnowledgeUploadResponseDto> {
    if (sizeBytes > this.maxBytes) {
      throw new PayloadTooLargeException(
        `Files are limited to ${this.maxBytes / 1024 / 1024} MB`,
      );
    }
    if (!/\.pdf$/i.test(filename)) {
      throw new UnsupportedMediaTypeException('Only PDF files are supported');
    }
    const id = randomUUID();
    const pathname = `knowledge/${id}.pdf`;

    const clientToken = await this.blob.createClientToken({
      pathname,
      contentType: PDF_CONTENT_TYPE,
      maxBytes: this.maxBytes,
      validUntil: Date.now() + UPLOAD_TOKEN_TTL_MS,
    });
    const document = await this.prisma.knowledgeDocument.create({
      data: {
        id,
        uploadedById: userId,
        title: filename,
        contentType: PDF_CONTENT_TYPE,
        blobPathname: pathname,
      },
    });

    return { document: toResponse(document), pathname, clientToken };
  }

  handleCallback(
    body: HandleUploadBody,
    request: IncomingMessage,
  ): Promise<void> {
    return this.blob.handleCallback(body, request, (pathname) =>
      this.markUploaded(pathname),
    );
  }

  /**
   * Moves a waiting document to PROCESSING and starts ingestion. Conditional,
   * so a retried callback and the cron can race safely.
   */
  async markUploaded(pathname: string): Promise<void> {
    const [document] = await this.prisma.knowledgeDocument.updateManyAndReturn({
      where: {
        blobPathname: pathname,
        status: KnowledgeDocumentStatus.WAITING_UPLOAD,
      },
      data: { status: KnowledgeDocumentStatus.PROCESSING },
    });
    // don't hold the callback open during extraction; failures land on the row
    if (document) void this.ingest(document);
  }

  async ingest(document: KnowledgeDocument): Promise<void> {
    try {
      const { sections, sizeBytes } = await failingWith(
        KnowledgeDocumentFailureReason.EXTRACTION_FAILED,
        this.extract(document.blobPathname),
      );
      const imageCount = await failingWith(
        KnowledgeDocumentFailureReason.INDEXING_FAILED,
        this.index.index(document, sections),
      );
      await this.prisma.knowledgeDocument.update({
        where: { id: document.id },
        data: {
          status: KnowledgeDocumentStatus.READY,
          failureReason: null,
          sectionCount: sections.length,
          imageCount,
          sizeBytes,
        },
      });
      this.logger.log(
        `Ingested ${document.id} (${sections.length} sections, ${imageCount} images)`,
      );
    } catch (error) {
      if (!(error instanceof IngestionError)) throw error;
      await this.prisma.knowledgeDocument.update({
        where: { id: document.id },
        data: {
          status: KnowledgeDocumentStatus.FAILED,
          failureReason: error.reason,
        },
      });
      this.logger.warn(`Rejected ${document.id}: ${error.message}`);
    }
  }

  private async extract(pathname: string) {
    const file = await this.blob.download(pathname);
    if (!file) {
      throw new IngestionError(
        KnowledgeDocumentFailureReason.UPLOAD_EXPIRED,
        'The upload is gone',
      );
    }
    return {
      sections: await this.pdf.extract(file),
      sizeBytes: file.byteLength,
    };
  }

  async findAll(): Promise<KnowledgeDocumentResponseDto[]> {
    const documents = await this.prisma.knowledgeDocument.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return documents.map(toResponse);
  }

  async findOne(id: string): Promise<KnowledgeDocumentResponseDto> {
    return toResponse(await this.findDocument(id));
  }

  /** Deletes the row last, so a failure leaves it to retry from. */
  async remove(id: string): Promise<void> {
    const document = await this.findDocument(id);
    await Promise.all([
      this.blob.delete(document.blobPathname),
      this.index.remove(id),
    ]);
    await this.prisma.knowledgeDocument.delete({ where: { id } });
  }

  private async findDocument(id: string): Promise<KnowledgeDocument> {
    const document = await this.prisma.knowledgeDocument.findUnique({
      where: { id },
    });
    if (!document) throw new NotFoundException('Document not found');
    return document;
  }
}

/** Tags a step's unexpected errors with the reason to store. */
async function failingWith<T>(
  reason: KnowledgeDocumentFailureReason,
  step: Promise<T>,
): Promise<T> {
  try {
    return await step;
  } catch (error) {
    if (error instanceof IngestionError) throw error;
    throw new IngestionError(reason, String(error));
  }
}

function toResponse(document: KnowledgeDocument): KnowledgeDocumentResponseDto {
  return {
    id: document.id,
    title: document.title,
    status: document.status,
    failureReason: document.failureReason,
    contentType: document.contentType,
    sectionCount: document.sectionCount,
    imageCount: document.imageCount,
    sizeBytes: document.sizeBytes,
    createdAt: document.createdAt,
  };
}
