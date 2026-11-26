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
import { MongoService } from '../mongo/mongo.service.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import { UnsupportedFileTypeException } from '../common/exceptions/unsupported-file-type.exception.js';

const FILE_URL_TTL_SECONDS = runtimeConfig.KNOWLEDGE_FILE_URL_TTL_SECONDS;

/** One extraction or indexing run, and the filter that matches its document only while the run owns it. */
interface DocumentRun {
  runId: string;
  filter: {
    _id: string;
    status: KnowledgeDocumentStatus;
    runId: string | null;
  };
}

function runOf(
  document: KnowledgeDocument,
  status: KnowledgeDocumentStatus,
): DocumentRun {
  return {
    // A document started before runs existed has no runId; its id tags the
    // points instead, and the filter matches the missing field.
    runId: document.runId ?? document.id,
    filter: { _id: document.id, status, runId: document.runId ?? null },
  };
}

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
    private readonly mongo: MongoService,
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

  async confirmUpload(id: string): Promise<KnowledgeDocumentResponseDto> {
    const existing = await this.findDocument(id);
    if (existing.status !== KnowledgeDocumentStatus.WAITING_UPLOAD) {
      return toResponse(existing);
    }
    const uploaded = await this.storage.exists(
      StorageTarget.Knowledge,
      existing.storageKey,
    );
    if (!uploaded) {
      throw new StateConflictException(
        'CONFLICT',
        'Uploaded file was not found in storage',
      );
    }
    const document = await this.documents
      .findOneAndUpdate(
        {
          _id: id,
          status: KnowledgeDocumentStatus.WAITING_UPLOAD,
        },
        {
          $set: {
            status: KnowledgeDocumentStatus.PROCESSING,
            runId: randomUUID(),
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (document) {
      void this.ingest(document);
      return toResponse(document);
    }
    return toResponse(await this.findDocument(id));
  }

  /** OCRs the file and parks the text for an admin to review. Nothing is indexed yet. */
  async ingest(document: KnowledgeDocument): Promise<void> {
    const run = runOf(document, KnowledgeDocumentStatus.PROCESSING);
    let file: Uint8Array;
    let sections: ExtractedSection[];
    try {
      file = await this.storage.getBytes(
        StorageTarget.Knowledge,
        document.storageKey,
      );
      sections = await this.pdf.extract(file);
    } catch (error) {
      await this.failExtraction(run, error);
      return;
    }

    let saved: boolean;
    try {
      // The pages are saved together with the status change, and only while
      // this run still owns a PROCESSING document: a run the cron failed, or
      // a document deleted meanwhile, leaves no pages behind.
      saved = await this.mongo.withTransaction(async (session) => {
        const claimed = await this.documents
          .updateOne(
            run.filter,
            {
              $set: {
                status: KnowledgeDocumentStatus.AWAITING_REVIEW,
                failureReason: null,
                sectionCount: sections.length,
                sizeBytes: file.byteLength,
              },
            },
            { session },
          )
          .exec();
        if (claimed.matchedCount !== 1) return false;
        await this.pages
          .deleteMany({ documentId: document.id }, { session })
          .exec();
        await this.pages.insertMany(
          sections.map(({ text, flags }, index) => ({
            documentId: document.id,
            page: index + 1,
            text,
            flags,
          })),
          { session },
        );
        return true;
      });
    } catch (error) {
      await this.failRun(run, KnowledgeDocumentFailureReason.EXTRACTION_FAILED);
      this.logger.error(
        `Saving pages of ${document.id} failed: ${String(error)}`,
      );
      return;
    }
    if (!saved) {
      this.logger.warn(
        `Discarded extraction of ${document.id}: the document moved on meanwhile`,
      );
      return;
    }
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
            runId: randomUUID(),
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
    const run = runOf(document, KnowledgeDocumentStatus.INDEXING);
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
      const imageCount = await this.index.index(
        { id: document.id, title: document.title, runId: run.runId },
        sections,
      );
      const finished = await this.documents
        .updateOne(run.filter, {
          $set: {
            status: KnowledgeDocumentStatus.READY,
            failureReason: null,
            imageCount,
          },
        })
        .exec();
      if (finished.matchedCount !== 1) {
        // Rejected, deleted, or re-approved meanwhile: drop this run's points.
        await this.index.removeRun(document.id, run.runId);
        this.logger.warn(
          `Discarded indexing of ${document.id}: the document moved on meanwhile`,
        );
        return;
      }
      // Points of earlier or overlapping runs (or from before runs) go.
      await this.index.removeOtherRuns(document.id, run.runId);
      this.logger.log(
        `Indexed ${document.id} (${sections.length} pages, ${imageCount} images)`,
      );
    } catch (error) {
      await this.returnToReview(
        run,
        KnowledgeDocumentFailureReason.INDEXING_FAILED,
      );
      await this.index
        .removeRun(document.id, run.runId)
        .catch((cleanup: unknown) =>
          this.logger.warn(
            `Removing points of a failed run of ${document.id} failed: ${String(cleanup)}`,
          ),
        );
      this.logger.error(`Indexing ${document.id} failed: ${String(error)}`);
    }
  }

  /** The reviewed pages are kept, so the admin can approve again. */
  private async returnToReview(
    run: DocumentRun,
    reason: KnowledgeDocumentFailureReason,
  ): Promise<void> {
    await this.documents.updateOne(run.filter, {
      $set: {
        status: KnowledgeDocumentStatus.AWAITING_REVIEW,
        failureReason: reason,
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
      },
    });
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

  private async failExtraction(
    run: DocumentRun,
    error: unknown,
  ): Promise<void> {
    const id = run.filter._id;
    if (error instanceof DocumentExtractionError) {
      await this.failRun(run, error.reason);
      this.logger.warn(`Rejected ${id}: ${error.message}`);
    } else if (error instanceof NoSuchKey) {
      await this.failRun(run, KnowledgeDocumentFailureReason.UPLOAD_EXPIRED);
    } else {
      await this.failRun(run, KnowledgeDocumentFailureReason.EXTRACTION_FAILED);
      this.logger.error(`Extracting ${id} failed: ${String(error)}`);
    }
  }

  /** Fails the document, unless another run or a person has moved it on. */
  private async failRun(
    run: DocumentRun,
    reason: KnowledgeDocumentFailureReason,
  ): Promise<void> {
    await this.documents.updateOne(run.filter, {
      $set: {
        status: KnowledgeDocumentStatus.FAILED,
        failureReason: reason,
      },
    });
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
