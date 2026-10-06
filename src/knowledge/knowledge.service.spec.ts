import {
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  KnowledgeDocument,
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
} from '@prisma/client';
import { NoSuchKey } from '@aws-sdk/client-s3';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import type { PresignedUploadDto } from '../storage/presigned-upload.dto';
import { StorageService, StorageTarget } from '../storage/storage.service';
import { DocumentExtractionError } from './extractors/document-extractor';
import { PdfExtractor } from './extractors/pdf-extractor';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeIndexService } from './retrieval/knowledge-index.service';

const documentId = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
const key = `knowledge/${documentId}.pdf`;
const presigned: PresignedUploadDto = {
  url: 'https://storage.vedora.vn/vedora-knowledge/knowledge/d.pdf?X-Amz-Signature=s',
  method: 'PUT',
  headers: { 'content-type': 'application/pdf' },
  expiresAt: new Date('2026-09-28T09:00:00Z'),
};

const waitingDocument: KnowledgeDocument = {
  id: documentId,
  uploadedById: '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2',
  title: 'dinh-duong.pdf',
  contentType: 'application/pdf',
  storageKey: key,
  sizeBytes: null,
  status: KnowledgeDocumentStatus.WAITING_UPLOAD,
  failureReason: null,
  sectionCount: null,
  imageCount: null,
  createdAt: new Date('2026-09-28T08:00:00Z'),
  updatedAt: new Date('2026-09-28T08:00:00Z'),
};

describe('KnowledgeService', () => {
  let service: KnowledgeService;
  let prisma: DeepMockProxy<PrismaService>;
  let extractor: DeepMockProxy<PdfExtractor>;
  let index: DeepMockProxy<KnowledgeIndexService>;
  let storage: DeepMockProxy<StorageService>;

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma = mockDeep<PrismaService>();
    extractor = mockDeep<PdfExtractor>();
    index = mockDeep<KnowledgeIndexService>();
    storage = mockDeep<StorageService>();
    const moduleRef = await Test.createTestingModule({
      providers: [
        KnowledgeService,
        { provide: StorageService, useValue: storage },
        { provide: PrismaService, useValue: prisma },
        { provide: PdfExtractor, useValue: extractor },
        { provide: KnowledgeIndexService, useValue: index },
        {
          provide: ConfigService,
          useValue: new ConfigService({ MAX_KNOWLEDGE_FILE_MB: 50 }),
        },
      ],
    }).compile();
    service = moduleRef.get(KnowledgeService);
  });

  describe('createUpload', () => {
    it('creates the document with an upload presigned for its key, type and size', async () => {
      storage.presignUpload.mockResolvedValue(presigned);
      prisma.knowledgeDocument.create.mockImplementation(
        ({ data }) => Promise.resolve({ ...waitingDocument, ...data }) as never,
      );

      const result = await service.createUpload(
        waitingDocument.uploadedById!,
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
      expect(
        prisma.knowledgeDocument.create.mock.calls[0][0].data,
      ).toMatchObject({
        title: 'Dinh Duong.PDF',
        contentType: 'application/pdf',
        storageKey,
      });
      expect(result.upload).toBe(presigned);
    });

    it('refuses anything but PDFs', async () => {
      await expect(
        service.createUpload('user', 'anh-mon-an.jpg', 1234),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(prisma.knowledgeDocument.create).not.toHaveBeenCalled();
    });

    it('refuses files over MAX_KNOWLEDGE_FILE_MB', async () => {
      await expect(
        service.createUpload('user', 'a.pdf', 50 * 1024 * 1024 + 1),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(prisma.knowledgeDocument.create).not.toHaveBeenCalled();
    });

    it('creates no document while storage is not configured', async () => {
      storage.presignUpload.mockRejectedValue(
        new ServiceUnavailableException(),
      );

      await expect(
        service.createUpload('user', 'a.pdf', 1),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.knowledgeDocument.create).not.toHaveBeenCalled();
    });
  });

  describe('markUploaded', () => {
    it('moves a waiting document to PROCESSING and ingests it', async () => {
      const processing = {
        ...waitingDocument,
        status: KnowledgeDocumentStatus.PROCESSING,
      };
      prisma.knowledgeDocument.updateManyAndReturn.mockResolvedValue([
        processing,
      ]);
      const ingest = vi.spyOn(service, 'ingest').mockResolvedValue();

      await service.markUploaded(key);

      expect(prisma.knowledgeDocument.updateManyAndReturn).toHaveBeenCalledWith(
        {
          where: {
            storageKey: key,
            status: KnowledgeDocumentStatus.WAITING_UPLOAD,
          },
          data: { status: KnowledgeDocumentStatus.PROCESSING },
        },
      );
      expect(ingest).toHaveBeenCalledWith(processing);
    });

    it('does nothing when a redelivered event finds it already moved on', async () => {
      prisma.knowledgeDocument.updateManyAndReturn.mockResolvedValue([]);
      const ingest = vi.spyOn(service, 'ingest');

      await service.markUploaded(key);

      expect(ingest).not.toHaveBeenCalled();
    });
  });

  describe('ingest', () => {
    const processing = {
      ...waitingDocument,
      status: KnowledgeDocumentStatus.PROCESSING,
    };

    beforeEach(() => {
      storage.getBytes.mockResolvedValue(new TextEncoder().encode('%PDF-1.4'));
    });

    it('indexes the sections and marks the document READY', async () => {
      const sections = [
        { text: 'Trang 1', images: [new Uint8Array([1])] },
        { text: 'Trang 2', images: [] },
      ];
      extractor.extract.mockResolvedValue(sections);
      index.index.mockResolvedValue(1);

      await service.ingest(processing);

      expect(storage.getBytes).toHaveBeenCalledWith(
        StorageTarget.Knowledge,
        key,
      );
      expect(extractor.extract).toHaveBeenCalledWith(expect.any(Uint8Array));
      expect(prisma.knowledgeDocument.update).toHaveBeenCalledWith({
        where: { id: documentId },
        data: {
          status: KnowledgeDocumentStatus.READY,
          failureReason: null,
          sectionCount: 2,
          imageCount: 1,
          sizeBytes: 8,
        },
      });
      expect(index.index).toHaveBeenCalledWith(processing, sections);
    });

    it('fails the document when indexing fails', async () => {
      extractor.extract.mockResolvedValue([{ text: 'Trang 1', images: [] }]);
      index.index.mockRejectedValue(new Error('Qdrant down'));

      await service.ingest(processing);

      expect(prisma.knowledgeDocument.update).toHaveBeenCalledWith({
        where: { id: documentId },
        data: {
          status: KnowledgeDocumentStatus.FAILED,
          failureReason: KnowledgeDocumentFailureReason.INDEXING_FAILED,
        },
      });
    });

    it('fails the document with the extraction reason', async () => {
      extractor.extract.mockRejectedValue(
        new DocumentExtractionError(
          KnowledgeDocumentFailureReason.NO_TEXT,
          'No page has a text layer',
        ),
      );

      await service.ingest(processing);

      expect(prisma.knowledgeDocument.update).toHaveBeenCalledWith({
        where: { id: documentId },
        data: {
          status: KnowledgeDocumentStatus.FAILED,
          failureReason: KnowledgeDocumentFailureReason.NO_TEXT,
        },
      });
    });

    it('fails the document when its file is gone', async () => {
      storage.getBytes.mockRejectedValue(
        new NoSuchKey({ message: 'gone', $metadata: {} }),
      );

      await service.ingest(processing);

      expect(prisma.knowledgeDocument.update).toHaveBeenCalledWith({
        where: { id: documentId },
        data: {
          status: KnowledgeDocumentStatus.FAILED,
          failureReason: KnowledgeDocumentFailureReason.UPLOAD_EXPIRED,
        },
      });
    });

    it('fails the document on unexpected errors', async () => {
      storage.getBytes.mockRejectedValue(new Error('network down'));

      await service.ingest(processing);

      expect(prisma.knowledgeDocument.update).toHaveBeenCalledWith({
        where: { id: documentId },
        data: {
          status: KnowledgeDocumentStatus.FAILED,
          failureReason: KnowledgeDocumentFailureReason.EXTRACTION_FAILED,
        },
      });
    });
  });

  describe('remove', () => {
    it('deletes the file, the Qdrant points, then the row', async () => {
      prisma.knowledgeDocument.findUnique.mockResolvedValue(waitingDocument);

      await service.remove(documentId);

      expect(storage.delete).toHaveBeenCalledWith(StorageTarget.Knowledge, key);
      expect(index.remove).toHaveBeenCalledWith(documentId);
      expect(prisma.knowledgeDocument.delete).toHaveBeenCalledWith({
        where: { id: documentId },
      });
    });
  });
});
