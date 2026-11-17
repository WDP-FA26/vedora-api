import type { INestApplication } from '@nestjs/common';
import { FileTooLargeException } from '../../../src/common/exceptions/file-too-large.exception.js';
import { FeatureUnavailableException } from '../../../src/common/exceptions/feature-unavailable.exception.js';
import { UnsupportedFileTypeException } from '../../../src/common/exceptions/unsupported-file-type.exception.js';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { NoSuchKey } from '@aws-sdk/client-s3';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { createUser } from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import {
  type KnowledgeDocument,
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
  type KnowledgePage,
  KnowledgePageFlag,
} from '../../../src/mongo/models.js';
import type { PresignedUploadDto } from '../../../src/storage/presigned-upload.dto.js';
import {
  StorageService,
  StorageTarget,
} from '../../../src/storage/storage.service.js';
import { StateConflictException } from '../../../src/common/exceptions/state-conflict.exception.js';
import { ResourceNotFoundException } from '../../../src/common/exceptions/resource-not-found.exception.js';
import { DocumentExtractionError } from '../../../src/knowledge/extractors/document-extractor.js';
import { PdfExtractor } from '../../../src/knowledge/extractors/pdf-extractor.js';
import { KnowledgeService } from '../../../src/knowledge/knowledge.service.js';
import { KnowledgeIndexService } from '../../../src/knowledge/retrieval/knowledge-index.service.js';

const presigned: PresignedUploadDto = {
  url: 'https://storage.vedora.vn/vedora-knowledge/knowledge/d.pdf?X-Amz-Signature=s',
  method: 'PUT',
  headers: { 'content-type': 'application/pdf' },
  expiresAt: new Date('2026-09-28T09:00:00Z'),
};

describe('KnowledgeService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: KnowledgeService;
  let extractor: DeepMockProxy<PdfExtractor>;
  let index: DeepMockProxy<KnowledgeIndexService>;
  let storage: DeepMockProxy<StorageService>;
  let uploaderId: string;

  const documents = () =>
    db.connection.model<KnowledgeDocument>('KnowledgeDocument');
  const addDocument = (status: KnowledgeDocumentStatus) => {
    const id = crypto.randomUUID();
    return documents().create({
      _id: id,
      uploadedById: uploaderId,
      title: 'dinh-duong.pdf',
      contentType: 'application/pdf',
      storageKey: `knowledge/${id}.pdf`,
      status,
    });
  };
  const pages = () => db.connection.model<KnowledgePage>('KnowledgePage');
  const addPages = (documentId: string, texts: string[]) =>
    pages().insertMany(
      texts.map((text, index) => ({ documentId, page: index + 1, text })),
    );
  const reload = (id: string) => documents().findById(id).exec();

  beforeAll(async () => {
    extractor = mockDeep<PdfExtractor>();
    index = mockDeep<KnowledgeIndexService>();
    storage = mockDeep<StorageService>();
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('knowledgeservice'))],
      providers: [
        KnowledgeService,
        { provide: StorageService, useValue: storage },
        { provide: PdfExtractor, useValue: extractor },
        { provide: KnowledgeIndexService, useValue: index },
        {
          provide: ConfigService,
          useValue: new ConfigService({ MAX_KNOWLEDGE_FILE_MB: 50 }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(KnowledgeService);
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.connection.collections.knowledge_documents.deleteMany({});
    await db.connection.collections.knowledge_pages.deleteMany({});
    extractor.extractImages.mockReset();
    storage.presignDownload.mockReset();
    extractor.extract.mockReset();
    index.index.mockReset();
    index.remove.mockReset();
    storage.presignUpload.mockReset();
    storage.getBytes.mockReset();
    storage.delete.mockReset();
    uploaderId = (await createUser(db)).id;
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  describe('createUpload', () => {
    it('creates the document with an upload presigned for its key, type and size', async () => {
      storage.presignUpload.mockResolvedValue(presigned);

      const result = await service.createUpload(
        uploaderId,
        'Dinh Duong.PDF',
        1234,
      );

      const storageKey = `knowledge/${result.document.id}.pdf`;
      expect(storage.presignUpload).toHaveBeenCalledWith(
        StorageTarget.Knowledge,
        storageKey,
        'application/pdf',
        1234,
      );
      expect(await reload(result.document.id)).toMatchObject({
        title: 'Dinh Duong.PDF',
        contentType: 'application/pdf',
        storageKey,
        status: KnowledgeDocumentStatus.WAITING_UPLOAD,
        uploadedById: uploaderId,
      });
      expect(result.upload).toBe(presigned);
    });

    it('refuses anything but PDFs', async () => {
      await expect(
        service.createUpload('user', 'anh-mon-an.jpg', 1234),
      ).rejects.toBeInstanceOf(UnsupportedFileTypeException);
      expect(await documents().countDocuments()).toBe(0);
    });

    it('refuses files over MAX_KNOWLEDGE_FILE_MB', async () => {
      await expect(
        service.createUpload('user', 'a.pdf', 50 * 1024 * 1024 + 1),
      ).rejects.toBeInstanceOf(FileTooLargeException);
      expect(await documents().countDocuments()).toBe(0);
    });

    it('creates no document while storage is not configured', async () => {
      storage.presignUpload.mockRejectedValue(
        new FeatureUnavailableException(
          'SERVICE_UNAVAILABLE',
          'File storage is not configured',
        ),
      );

      await expect(
        service.createUpload('user', 'a.pdf', 1),
      ).rejects.toBeInstanceOf(FeatureUnavailableException);
      expect(await documents().countDocuments()).toBe(0);
    });
  });

  describe('markUploaded', () => {
    it('moves a waiting document to PROCESSING and ingests it', async () => {
      const waiting = await addDocument(KnowledgeDocumentStatus.WAITING_UPLOAD);
      const ingest = vi.spyOn(service, 'ingest').mockResolvedValue();

      await service.markUploaded(waiting.storageKey);

      expect((await reload(waiting.id))?.status).toBe(
        KnowledgeDocumentStatus.PROCESSING,
      );
      expect(ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          id: waiting.id,
          status: KnowledgeDocumentStatus.PROCESSING,
        }),
      );
    });

    it('starts one ingestion when the event is redelivered', async () => {
      const waiting = await addDocument(KnowledgeDocumentStatus.WAITING_UPLOAD);
      const ingest = vi.spyOn(service, 'ingest').mockResolvedValue();

      await Promise.all([
        service.markUploaded(waiting.storageKey),
        service.markUploaded(waiting.storageKey),
        service.markUploaded(waiting.storageKey),
      ]);

      expect(ingest).toHaveBeenCalledTimes(1);
    });

    it('does nothing when it finds the document already moved on', async () => {
      const done = await addDocument(KnowledgeDocumentStatus.READY);
      const ingest = vi.spyOn(service, 'ingest');

      await service.markUploaded(done.storageKey);

      expect(ingest).not.toHaveBeenCalled();
      expect((await reload(done.id))?.status).toBe(
        KnowledgeDocumentStatus.READY,
      );
    });
  });

  describe('ingest', () => {
    beforeEach(() => {
      storage.getBytes.mockResolvedValue(new TextEncoder().encode('%PDF-1.4'));
    });

    it('saves the pages for review without indexing anything', async () => {
      const processing = await addDocument(KnowledgeDocumentStatus.PROCESSING);
      extractor.extract.mockResolvedValue([
        { text: 'Trang 1', images: [new Uint8Array([1])], flags: [] },
        {
          text: 'Trang 2',
          images: [],
          flags: [KnowledgePageFlag.TEXT_LAYER_ADDED],
        },
      ]);

      await service.ingest(processing);

      expect(storage.getBytes).toHaveBeenCalledWith(
        StorageTarget.Knowledge,
        processing.storageKey,
      );
      expect(await reload(processing.id)).toMatchObject({
        status: KnowledgeDocumentStatus.AWAITING_REVIEW,
        failureReason: null,
        sectionCount: 2,
        sizeBytes: 8,
      });
      expect(await service.listPages(processing.id)).toEqual([
        { page: 1, text: 'Trang 1', flags: [], edited: false },
        {
          page: 2,
          text: 'Trang 2',
          flags: [KnowledgePageFlag.TEXT_LAYER_ADDED],
          edited: false,
        },
      ]);
      expect(index.index).not.toHaveBeenCalled();
    });

    it('fails the document with the extraction reason', async () => {
      const processing = await addDocument(KnowledgeDocumentStatus.PROCESSING);
      extractor.extract.mockRejectedValue(
        new DocumentExtractionError(
          KnowledgeDocumentFailureReason.NO_TEXT,
          'No page has a text layer',
        ),
      );

      await service.ingest(processing);

      expect(await reload(processing.id)).toMatchObject({
        status: KnowledgeDocumentStatus.FAILED,
        failureReason: KnowledgeDocumentFailureReason.NO_TEXT,
      });
    });

    it('fails the document when its file is gone', async () => {
      const processing = await addDocument(KnowledgeDocumentStatus.PROCESSING);
      storage.getBytes.mockRejectedValue(
        new NoSuchKey({ message: 'gone', $metadata: {} }),
      );

      await service.ingest(processing);

      expect(await reload(processing.id)).toMatchObject({
        status: KnowledgeDocumentStatus.FAILED,
        failureReason: KnowledgeDocumentFailureReason.UPLOAD_EXPIRED,
      });
    });

    it('fails the document on unexpected errors', async () => {
      const processing = await addDocument(KnowledgeDocumentStatus.PROCESSING);
      storage.getBytes.mockRejectedValue(new Error('network down'));

      await service.ingest(processing);

      expect(await reload(processing.id)).toMatchObject({
        status: KnowledgeDocumentStatus.FAILED,
        failureReason: KnowledgeDocumentFailureReason.EXTRACTION_FAILED,
      });
    });
  });

  describe('review', () => {
    it('lets an admin correct a page while the document awaits review', async () => {
      const waiting = await addDocument(
        KnowledgeDocumentStatus.AWAITING_REVIEW,
      );
      await addPages(waiting.id, ['Dau phu 8g', 'Trang 2']);

      const page = await service.updatePage(waiting.id, 1, 'Đậu phụ 8g');

      expect(page).toEqual({
        page: 1,
        text: 'Đậu phụ 8g',
        flags: [],
        edited: true,
      });
      expect((await service.listPages(waiting.id))[1].edited).toBe(false);
    });

    it('refuses edits outside review and for missing pages', async () => {
      const done = await addDocument(KnowledgeDocumentStatus.READY);
      await addPages(done.id, ['a']);
      const waiting = await addDocument(
        KnowledgeDocumentStatus.AWAITING_REVIEW,
      );

      await expect(service.updatePage(done.id, 1, 'b')).rejects.toBeInstanceOf(
        StateConflictException,
      );
      await expect(
        service.updatePage(waiting.id, 9, 'b'),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });

    it('approves once, then indexes the reviewed text with the page images', async () => {
      const waiting = await addDocument(
        KnowledgeDocumentStatus.AWAITING_REVIEW,
      );
      await addPages(waiting.id, ['Trang 1', 'Trang 2']);
      await service.updatePage(waiting.id, 2, 'Trang 2 da sua');
      const jpeg = new Uint8Array([1]);
      storage.getBytes.mockResolvedValue(new Uint8Array([9]));
      extractor.extractImages.mockResolvedValue([[jpeg], []]);
      index.index.mockResolvedValue(1);

      const results = await Promise.allSettled([
        service.approve(uploaderId, waiting.id, 'ok'),
        service.approve(uploaderId, waiting.id, null),
      ]);
      await vi.waitFor(async () =>
        expect((await reload(waiting.id))?.status).toBe(
          KnowledgeDocumentStatus.READY,
        ),
      );

      expect(
        results.filter(({ status }) => status === 'rejected'),
      ).toHaveLength(1);
      expect(index.index).toHaveBeenCalledTimes(1);
      expect(index.index).toHaveBeenCalledWith(
        expect.objectContaining({ id: waiting.id }),
        [
          { text: 'Trang 1', images: [jpeg] },
          { text: 'Trang 2 da sua', images: [] },
        ],
      );
      expect(await reload(waiting.id)).toMatchObject({
        imageCount: 1,
        reviewedById: uploaderId,
      });
    });

    it('returns to review with INDEXING_FAILED when indexing fails, keeping the edits', async () => {
      const waiting = await addDocument(
        KnowledgeDocumentStatus.AWAITING_REVIEW,
      );
      await addPages(waiting.id, ['Trang 1']);
      storage.getBytes.mockResolvedValue(new Uint8Array([9]));
      extractor.extractImages.mockResolvedValue([[]]);
      index.index.mockRejectedValue(new Error('Qdrant down'));

      await service.approve(uploaderId, waiting.id, null);
      await vi.waitFor(async () =>
        expect((await reload(waiting.id))?.failureReason).toBe(
          KnowledgeDocumentFailureReason.INDEXING_FAILED,
        ),
      );

      expect(await reload(waiting.id)).toMatchObject({
        status: KnowledgeDocumentStatus.AWAITING_REVIEW,
        reviewedById: null,
      });
      expect(await pages().countDocuments({ documentId: waiting.id })).toBe(1);
    });

    it('rejects without deleting, then lets an admin reopen', async () => {
      const waiting = await addDocument(
        KnowledgeDocumentStatus.AWAITING_REVIEW,
      );
      await addPages(waiting.id, ['Trang 1']);

      await service.reject(uploaderId, waiting.id, 'Sai nguồn');

      expect(await reload(waiting.id)).toMatchObject({
        status: KnowledgeDocumentStatus.REJECTED,
        reviewedById: uploaderId,
        reviewNote: 'Sai nguồn',
      });
      expect(await pages().countDocuments({ documentId: waiting.id })).toBe(1);
      expect(storage.delete).not.toHaveBeenCalled();
      expect(index.index).not.toHaveBeenCalled();
      await expect(
        service.updatePage(waiting.id, 1, 'x'),
      ).rejects.toBeInstanceOf(StateConflictException);

      await service.reopen(waiting.id);

      expect(await reload(waiting.id)).toMatchObject({
        status: KnowledgeDocumentStatus.AWAITING_REVIEW,
        reviewedById: null,
        reviewNote: null,
      });
    });

    it('only reviews documents that await review, and only reopens rejected ones', async () => {
      const done = await addDocument(KnowledgeDocumentStatus.READY);

      await expect(
        service.approve(uploaderId, done.id, null),
      ).rejects.toBeInstanceOf(StateConflictException);
      await expect(
        service.reject(uploaderId, done.id, null),
      ).rejects.toBeInstanceOf(StateConflictException);
      await expect(service.reopen(done.id)).rejects.toBeInstanceOf(
        StateConflictException,
      );
      await expect(
        service.approve(uploaderId, crypto.randomUUID(), null),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });

    it('presigns the original file', async () => {
      const waiting = await addDocument(
        KnowledgeDocumentStatus.AWAITING_REVIEW,
      );
      storage.presignDownload.mockResolvedValue('https://storage/x.pdf?sig');

      const result = await service.fileUrl(waiting.id);

      expect(result.url).toBe('https://storage/x.pdf?sig');
      expect(storage.presignDownload).toHaveBeenCalledWith(
        StorageTarget.Knowledge,
        waiting.storageKey,
        expect.any(Number),
      );
    });
  });

  describe('remove', () => {
    it('deletes the file, the Qdrant points, then the row', async () => {
      const waiting = await addDocument(KnowledgeDocumentStatus.WAITING_UPLOAD);

      await service.remove(waiting.id);

      expect(storage.delete).toHaveBeenCalledWith(
        StorageTarget.Knowledge,
        waiting.storageKey,
      );
      expect(index.remove).toHaveBeenCalledWith(waiting.id);
      expect(await documents().findById(waiting.id).exec()).toBeNull();
    });

    it('deletes the saved pages too', async () => {
      const rejected = await addDocument(KnowledgeDocumentStatus.REJECTED);
      await addPages(rejected.id, ['a', 'b']);

      await service.remove(rejected.id);

      expect(await pages().countDocuments({ documentId: rejected.id })).toBe(0);
    });

    it('keeps the row when the file cannot be deleted, to retry from', async () => {
      const waiting = await addDocument(KnowledgeDocumentStatus.WAITING_UPLOAD);
      storage.delete.mockRejectedValue(new Error('storage down'));

      await expect(service.remove(waiting.id)).rejects.toThrow('storage down');
      expect(await documents().findById(waiting.id).exec()).not.toBeNull();
    });
  });
});
