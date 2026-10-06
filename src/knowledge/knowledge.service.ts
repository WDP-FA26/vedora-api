import { randomUUID } from 'node:crypto';
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
import { NoSuchKey } from '@aws-sdk/client-s3';
import { StorageService, StorageTarget } from '../storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateKnowledgeUploadResponseDto,
  KnowledgeDocumentResponseDto,
} from './dto/knowledge-document-response.dto';
import {
  DocumentExtractionError,
  type ExtractedSection,
} from './extractors/document-extractor';
import { PDF_CONTENT_TYPE, PdfExtractor } from './extractors/pdf-extractor';
import { KnowledgeIndexService } from './retrieval/knowledge-index.service';

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);
  private readonly maxBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly pdf: PdfExtractor,
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
    if (sizeBytes > this.maxBytes) {
      throw new PayloadTooLargeException(
        `Files are limited to ${this.maxBytes / 1024 / 1024} MB`,
      );
    }
    if (!/\.pdf$/i.test(filename)) {
      throw new UnsupportedMediaTypeException('Only PDF files are supported');
    }
    const id = randomUUID();
    const key = `knowledge/${id}.pdf`;
    const upload = await this.storage.presignUpload(
      StorageTarget.Knowledge,
      key,
      PDF_CONTENT_TYPE,
      sizeBytes,
    );
    const document = await this.prisma.knowledgeDocument.create({
      data: {
        id,
        uploadedById: userId,
        title: filename,
        contentType: PDF_CONTENT_TYPE,
        storageKey: key,
      },
    });

    return { document: toResponse(document), upload };
  }

  async markUploaded(key: string): Promise<void> {
    const [document] = await this.prisma.knowledgeDocument.updateManyAndReturn({
      where: {
        storageKey: key,
        status: KnowledgeDocumentStatus.WAITING_UPLOAD,
      },
      data: { status: KnowledgeDocumentStatus.PROCESSING },
    });
    // don't hold the event open during extraction; failures land on the row
    if (document) void this.ingest(document);
    else this.logger.warn(`No waiting document for ${key}`);
  }

  async ingest(document: KnowledgeDocument): Promise<void> {
    let file: Uint8Array;
    let sections: ExtractedSection[];
    try {
      file = await this.storage.getBytes(
        StorageTarget.Knowledge,
        document.storageKey,
      );
      sections = await this.pdf.extract(file);
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

    await this.prisma.knowledgeDocument.update({
      where: { id: document.id },
      data: {
        status: KnowledgeDocumentStatus.READY,
        failureReason: null,
        sectionCount: sections.length,
        imageCount,
        sizeBytes: file.byteLength,
      },
    });
    this.logger.log(
      `Ingested ${document.id} (${sections.length} sections, ${imageCount} images)`,
    );
  }

  private async failExtraction(id: string, error: unknown): Promise<void> {
    if (error instanceof DocumentExtractionError) {
      await this.fail(id, error.reason);
      this.logger.warn(`Rejected ${id}: ${error.message}`);
    } else if (error instanceof NoSuchKey) {
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
    await this.storage.delete(StorageTarget.Knowledge, document.storageKey);
    await this.index.remove(id);
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
