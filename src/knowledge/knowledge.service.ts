import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  BadRequestException,
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
import { BlobNotFoundError, del, get } from '@vercel/blob';
import {
  generateClientTokenFromReadWriteToken,
  handleUpload,
  type HandleUploadBody,
} from '@vercel/blob/client';
import { BlobService } from '../blob/blob.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateKnowledgeUploadResponseDto,
  KnowledgeDocumentResponseDto,
} from './dto/knowledge-document-response.dto';
import {
  DocumentExtractionError,
  type ExtractedSection,
} from './extractors/document-extractor';
import { DocumentExtractorRegistry } from './extractors/document-extractor.registry';
import { KnowledgeIndexService } from './retrieval/knowledge-index.service';

/** Client tokens stop accepting the upload after this long. */
export const UPLOAD_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Knowledge-base files go straight from the browser to Vercel Blob:
 * `createUpload` picks the file type's extractor, then creates the document
 * row and a client token scoped to its pathname and content type. Only Vercel
 * Blob's signed upload-completed callback (`handleCallback`) starts
 * ingestion; the browser is never trusted to say an upload finished.
 * `markUploaded` moves the row to PROCESSING exactly once (Vercel retries
 * callbacks), and `ingest` runs the extractor for its content type and
 * indexes the result into Qdrant. The maintenance cron fails documents that
 * never complete.
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);
  private readonly maxBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly extractors: DocumentExtractorRegistry,
    private readonly index: KnowledgeIndexService,
    configService: ConfigService,
  ) {
    this.maxBytes =
      configService.get<number>('MAX_KNOWLEDGE_FILE_MB', 50) * 1024 * 1024;
  }

  async createUpload(
    userId: string,
    filename: string,
    sizeBytes: number,
  ): Promise<CreateKnowledgeUploadResponseDto> {
    const token = this.blob.require();
    const callbackUrl = this.blob.requireCallbackUrl();
    if (sizeBytes > this.maxBytes) {
      throw new PayloadTooLargeException(
        `Files are limited to ${this.maxBytes / 1024 / 1024} MB`,
      );
    }
    const format = this.extractors.formatFor(filename);
    if (!format) {
      throw new UnsupportedMediaTypeException(
        `Supported file types: ${this.extractors.extensions.join(', ')}`,
      );
    }
    const id = randomUUID();
    const pathname = `knowledge/${id}.${format.extension}`;

    const clientToken = await generateClientTokenFromReadWriteToken({
      token,
      pathname,
      allowedContentTypes: [format.contentType],
      maximumSizeInBytes: this.maxBytes,
      validUntil: Date.now() + UPLOAD_TOKEN_TTL_MS,
      onUploadCompleted: { callbackUrl, tokenPayload: id },
    });
    const document = await this.prisma.knowledgeDocument.create({
      data: {
        id,
        uploadedById: userId,
        title: filename,
        contentType: format.contentType,
        blobPathname: pathname,
      },
    });

    return { document: toResponse(document), pathname, clientToken };
  }

  /**
   * Verifies Vercel Blob's upload-completed callback. Token requests are
   * refused here: tokens only come from the authenticated `createUpload`.
   */
  async handleCallback(
    body: HandleUploadBody,
    request: IncomingMessage,
  ): Promise<void> {
    if (body?.type !== 'blob.upload-completed') {
      throw new BadRequestException('Expected an upload-completed callback');
    }
    await handleUpload({
      token: this.blob.require(),
      body,
      request,
      onBeforeGenerateToken: () =>
        Promise.reject(
          new Error('Tokens are issued by POST /knowledge/documents'),
        ),
      onUploadCompleted: async ({ blob }) => {
        await this.markUploaded(blob.pathname);
      },
    });
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
    const extractor = this.extractors.extractorFor(document.contentType);
    if (!extractor) {
      await this.fail(
        document.id,
        KnowledgeDocumentFailureReason.UNSUPPORTED_TYPE,
      );
      return;
    }
    let file: Uint8Array;
    let sections: ExtractedSection[];
    try {
      file = await this.download(document.blobPathname);
      sections = await extractor.extract(file, document.contentType);
    } catch (error) {
      await this.failExtraction(document.id, error);
      return;
    }

    let imageCount: number;
    try {
      imageCount = await this.index.index(document, sections);
    } catch (error) {
      await this.fail(
        document.id,
        KnowledgeDocumentFailureReason.INDEXING_FAILED,
      );
      this.logger.error(`Indexing ${document.id} failed: ${String(error)}`);
      return;
    }

    await this.prisma.$transaction([
      this.prisma.knowledgeDocumentSection.deleteMany({
        where: { documentId: document.id },
      }),
      this.prisma.knowledgeDocumentSection.createMany({
        data: sections.map(({ text }, index) => ({
          documentId: document.id,
          position: index + 1,
          text,
        })),
      }),
      this.prisma.knowledgeDocument.update({
        where: { id: document.id },
        data: {
          status: KnowledgeDocumentStatus.READY,
          failureReason: null,
          sectionCount: sections.length,
          imageCount,
          sizeBytes: file.byteLength,
        },
      }),
    ]);
    this.logger.log(
      `Ingested ${document.id} (${sections.length} sections, ${imageCount} images)`,
    );
  }

  private async failExtraction(id: string, error: unknown): Promise<void> {
    if (error instanceof DocumentExtractionError) {
      await this.fail(id, error.reason);
      this.logger.warn(`Rejected ${id}: ${error.message}`);
    } else if (error instanceof BlobNotFoundError) {
      await this.fail(id, KnowledgeDocumentFailureReason.UPLOAD_EXPIRED);
    } else {
      await this.fail(id, KnowledgeDocumentFailureReason.EXTRACTION_FAILED);
      this.logger.error(`Extracting ${id} failed: ${String(error)}`);
    }
  }

  async fail(
    id: string,
    reason: KnowledgeDocumentFailureReason,
  ): Promise<void> {
    await this.prisma.knowledgeDocument.update({
      where: { id },
      data: { status: KnowledgeDocumentStatus.FAILED, failureReason: reason },
    });
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
    await del(document.blobPathname, { token: this.blob.require() });
    await this.index.remove(id);
    await this.prisma.knowledgeDocument.delete({ where: { id } });
  }

  private async download(pathname: string): Promise<Uint8Array> {
    const result = await get(pathname, {
      access: 'private',
      token: this.blob.require(),
    });
    if (!result || result.statusCode !== 200) {
      throw new BlobNotFoundError();
    }
    return new Uint8Array(await new Response(result.stream).arrayBuffer());
  }

  private async findDocument(id: string): Promise<KnowledgeDocument> {
    const document = await this.prisma.knowledgeDocument.findUnique({
      where: { id },
    });
    if (!document) throw new NotFoundException('Document not found');
    return document;
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
