import { runtimeConfig } from '../config/runtime-config.js';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { FileTooLargeException } from '../common/exceptions/file-too-large.exception.js';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  KnowledgeDocument,
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
  KnowledgePage,
} from '../mongo/models.js';
import { NoSuchKey } from '@aws-sdk/client-s3';
import { StorageService, StorageTarget } from '../storage/storage.service.js';
import {
  CreateKnowledgeUploadResponseDto,
  KnowledgeDocumentResponseDto,
  KnowledgeFileUrlResponseDto,
  KnowledgePageResponseDto,
} from './dto/knowledge-document-response.dto.js';
import {
  DocumentExtractionError,
  type ExtractedSection,
} from './extractors/document-extractor.js';
import { PDF_CONTENT_TYPE, PdfExtractor } from './extractors/pdf-extractor.js';
import { KnowledgeIndexService } from './retrieval/knowledge-index.service.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { UnsupportedFileTypeException } from '../common/exceptions/unsupported-file-type.exception.js';

const FILE_URL_TTL_SECONDS = runtimeConfig.KNOWLEDGE_FILE_URL_TTL_SECONDS;

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);
  private readonly maxBytes: number;

  constructor(
    @InjectModel(KnowledgeDocument.name)
    private readonly documents: Model<KnowledgeDocument>,
    @InjectModel(KnowledgePage.name)
    private readonly pages: Model<KnowledgePage>,
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
      throw new FileTooLargeException(
        'FILE_TOO_LARGE',
        `Files are limited to ${this.maxBytes / 1024 / 1024} MB`,
      );
    }
    if (!/\.pdf$/i.test(filename)) {
      throw new UnsupportedFileTypeException(
        'UNSUPPORTED_FILE_TYPE',
        'Only PDF files are supported',
      );
    }
    const id = randomUUID();
    const key = `knowledge/${id}.pdf`;
    const upload = await this.storage.presignUpload(
      StorageTarget.Knowledge,
      key,
      PDF_CONTENT_TYPE,
      sizeBytes,
    );
    const document = await this.documents.create({
      _id: id,
      uploadedById: userId,
      title: filename,
      contentType: PDF_CONTENT_TYPE,
      storageKey: key,
      status: KnowledgeDocumentStatus.WAITING_UPLOAD,
    });

    return { document: toResponse(document), upload };
  }

  async markUploaded(key: string): Promise<void> {
    const document = await this.documents
      .findOneAndUpdate(
        {
          storageKey: key,
          status: KnowledgeDocumentStatus.WAITING_UPLOAD,
        },
        { $set: { status: KnowledgeDocumentStatus.PROCESSING } },
        { returnDocument: 'after' },
      )
      .exec();
    if (document) void this.ingest(document);
    else this.logger.warn(`No waiting document for ${key}`);
  }

  /** OCRs the file and parks the text for an admin to review. Nothing is indexed yet. */
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

    try {
      await this.pages.deleteMany({ documentId: document.id }).exec();
      await this.pages.insertMany(
        sections.map(({ text, flags }, index) => ({
          documentId: document.id,
          page: index + 1,
          text,
          flags,
        })),
      );
    } catch (error) {
      await this.fail(
        document.id,
        KnowledgeDocumentFailureReason.EXTRACTION_FAILED,
      );
      this.logger.error(
        `Saving pages of ${document.id} failed: ${String(error)}`,
      );
      return;
    }

    await this.documents.updateOne(
      { _id: document.id },
      {
        $set: {
          status: KnowledgeDocumentStatus.AWAITING_REVIEW,
          failureReason: null,
          sectionCount: sections.length,
          sizeBytes: file.byteLength,
        },
      },
    );
    this.logger.log(
      `Extracted ${document.id} (${sections.length} pages), awaiting review`,
    );
  }

  async listPages(id: string): Promise<KnowledgePageResponseDto[]> {
    await this.findDocument(id);
    const pages = await this.pages
      .find({ documentId: id })
      .sort({ page: 1 })
      .exec();
    return pages.map(toPageResponse);
  }

  async updatePage(
    id: string,
    page: number,
    text: string,
  ): Promise<KnowledgePageResponseDto> {
    const document = await this.findDocument(id);
    this.requireStatus(document, KnowledgeDocumentStatus.AWAITING_REVIEW);
    const updated = await this.pages
      .findOneAndUpdate(
        { documentId: id, page },
        { $set: { text, edited: true } },
        { returnDocument: 'after' },
      )
      .exec();
    if (!updated) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Page not found');
    }
    return toPageResponse(updated);
  }

  /** Starts indexing the reviewed text; a second call while indexing gets a 409. */
  async approve(
    adminId: string,
    id: string,
    note: string | null,
  ): Promise<KnowledgeDocumentResponseDto> {
    const document = await this.documents
      .findOneAndUpdate(
        { _id: id, status: KnowledgeDocumentStatus.AWAITING_REVIEW },
        {
          $set: {
            status: KnowledgeDocumentStatus.INDEXING,
            failureReason: null,
            reviewedById: adminId,
            reviewedAt: new Date(),
            reviewNote: note,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!document) throw await this.notReviewable(id);
    void this.indexApproved(document);
    return toResponse(document);
  }

  async indexApproved(document: KnowledgeDocument): Promise<void> {
    try {
      const file = await this.storage.getBytes(
        StorageTarget.Knowledge,
        document.storageKey,
      );
      const imagesByPage = await this.pdf.extractImages(file);
      const pages = await this.pages
        .find({ documentId: document.id })
        .sort({ page: 1 })
        .exec();
      const sections = pages.map(({ page, text }) => ({
        text,
        images: imagesByPage[page - 1] ?? [],
      }));
      const imageCount = await this.index.index(document, sections);
      await this.documents.updateOne(
        { _id: document.id },
        {
          $set: {
            status: KnowledgeDocumentStatus.READY,
            failureReason: null,
            imageCount,
          },
        },
      );
      this.logger.log(
        `Indexed ${document.id} (${sections.length} pages, ${imageCount} images)`,
      );
    } catch (error) {
      await this.returnToReview(
        document.id,
        KnowledgeDocumentFailureReason.INDEXING_FAILED,
      );
      this.logger.error(`Indexing ${document.id} failed: ${String(error)}`);
    }
  }

  /** The reviewed pages are kept, so the admin can approve again. */
  async returnToReview(
    id: string,
    reason: KnowledgeDocumentFailureReason,
  ): Promise<void> {
    await this.documents.updateOne(
      { _id: id },
      {
        $set: {
          status: KnowledgeDocumentStatus.AWAITING_REVIEW,
          failureReason: reason,
          reviewedById: null,
          reviewedAt: null,
          reviewNote: null,
        },
      },
    );
  }

  /** Declines the document but keeps its file and pages. `remove` deletes. */
  async reject(
    adminId: string,
    id: string,
    note: string | null,
  ): Promise<KnowledgeDocumentResponseDto> {
    const document = await this.documents
      .findOneAndUpdate(
        { _id: id, status: KnowledgeDocumentStatus.AWAITING_REVIEW },
        {
          $set: {
            status: KnowledgeDocumentStatus.REJECTED,
            failureReason: null,
            reviewedById: adminId,
            reviewedAt: new Date(),
            reviewNote: note,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!document) throw await this.notReviewable(id);
    return toResponse(document);
  }

  async reopen(id: string): Promise<KnowledgeDocumentResponseDto> {
    const document = await this.documents
      .findOneAndUpdate(
        { _id: id, status: KnowledgeDocumentStatus.REJECTED },
        {
          $set: {
            status: KnowledgeDocumentStatus.AWAITING_REVIEW,
            reviewedById: null,
            reviewedAt: null,
            reviewNote: null,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!document) throw await this.notReviewable(id);
    return toResponse(document);
  }

  async fileUrl(id: string): Promise<KnowledgeFileUrlResponseDto> {
    const document = await this.findDocument(id);
    const url = await this.storage.presignDownload(
      StorageTarget.Knowledge,
      document.storageKey,
      FILE_URL_TTL_SECONDS,
    );
    return {
      url,
      expiresAt: new Date(Date.now() + FILE_URL_TTL_SECONDS * 1000),
    };
  }

  private requireStatus(
    document: KnowledgeDocument,
    status: KnowledgeDocumentStatus,
  ): void {
    if (document.status === status) return;
    throw new StateConflictException(
      'DOCUMENT_NOT_REVIEWABLE',
      `The document is ${document.status}, not ${status}`,
    );
  }

  private async notReviewable(id: string): Promise<Error> {
    const document = await this.findDocument(id);
    return new StateConflictException(
      'DOCUMENT_NOT_REVIEWABLE',
      `The document is ${document.status}`,
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
    await this.documents.updateOne(
      { _id: id },
      {
        $set: {
          status: KnowledgeDocumentStatus.FAILED,
          failureReason: reason,
        },
      },
    );
  }

  async findAll(): Promise<KnowledgeDocumentResponseDto[]> {
    const documents = await this.documents
      .find()
      .sort({ createdAt: -1, _id: -1 })
      .exec();
    return documents.map(toResponse);
  }

  async findOne(id: string): Promise<KnowledgeDocumentResponseDto> {
    return toResponse(await this.findDocument(id));
  }

  async remove(id: string): Promise<void> {
    const document = await this.findDocument(id);
    await this.storage.delete(StorageTarget.Knowledge, document.storageKey);
    await this.index.remove(id);
    await this.documents.deleteOne({ _id: id }).exec();
  }

  private async findDocument(id: string): Promise<KnowledgeDocument> {
    const document = await this.documents.findOne({ _id: id }).exec();
    if (!document)
      throw new ResourceNotFoundException('NOT_FOUND', 'Document not found');
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
    reviewedById: document.reviewedById,
    reviewedAt: document.reviewedAt,
    reviewNote: document.reviewNote,
    createdAt: document.createdAt,
  };
}

function toPageResponse(page: KnowledgePage): KnowledgePageResponseDto {
  return {
    page: page.page,
    text: page.text,
    flags: page.flags,
    edited: page.edited,
  };
}
