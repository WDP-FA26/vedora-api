import type { INestApplication } from '@nestjs/common';
import { FileTooLargeException } from '../common/exceptions/file-too-large.exception.js';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';
import { UnsupportedFileTypeException } from '../common/exceptions/unsupported-file-type.exception.js';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { NoSuchKey } from '@aws-sdk/client-s3';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { createUser } from '../../test/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db.js';
import { MongoModule } from '../mongo/mongo.module.js';
import { MongoService } from '../mongo/mongo.service.js';
import {
  type KnowledgeDocument,
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
} from '../mongo/models.js';
import type { PresignedUploadDto } from '../storage/presigned-upload.dto.js';
import { StorageService, StorageTarget } from '../storage/storage.service.js';
import { DocumentExtractionError } from './extractors/document-extractor.js';
import { PdfExtractor } from './extractors/pdf-extractor.js';
import { KnowledgeService } from './knowledge.service.js';
import { KnowledgeIndexService } from './retrieval/knowledge-index.service.js';

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
  /** A document row in `status`, as the upload endpoint leaves it. */
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

    it('indexes the sections and marks the document READY', async () => {
      const processing = await addDocument(KnowledgeDocumentStatus.PROCESSING);
      const sections = [
        { text: 'Trang 1', images: [new Uint8Array([1])] },
        { text: 'Trang 2', images: [] },
      ];
      extractor.extract.mockResolvedValue(sections);
      index.index.mockResolvedValue(1);

      await service.ingest(processing);

      expect(storage.getBytes).toHaveBeenCalledWith(
        StorageTarget.Knowledge,
        processing.storageKey,
      );
      expect(extractor.extract).toHaveBeenCalledWith(expect.any(Uint8Array));
      expect(await reload(processing.id)).toMatchObject({
        status: KnowledgeDocumentStatus.READY,
        failureReason: null,
        sectionCount: 2,
        imageCount: 1,
        sizeBytes: 8,
      });
      expect(index.index).toHaveBeenCalledWith(processing, sections);
    });

    it('fails the document when indexing fails', async () => {
      const processing = await addDocument(KnowledgeDocumentStatus.PROCESSING);
      extractor.extract.mockResolvedValue([{ text: 'Trang 1', images: [] }]);
      index.index.mockRejectedValue(new Error('Qdrant down'));

      await service.ingest(processing);

      expect(await reload(processing.id)).toMatchObject({
        status: KnowledgeDocumentStatus.FAILED,
        failureReason: KnowledgeDocumentFailureReason.INDEXING_FAILED,
      });
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

    it('keeps the row when the file cannot be deleted, to retry from', async () => {
      const waiting = await addDocument(KnowledgeDocumentStatus.WAITING_UPLOAD);
      storage.delete.mockRejectedValue(new Error('storage down'));

      await expect(service.remove(waiting.id)).rejects.toThrow('storage down');
      expect(await documents().findById(waiting.id).exec()).not.toBeNull();
    });
  });
});
