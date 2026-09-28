import {
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  KnowledgeDocument,
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
} from '@prisma/client';
import { del, get } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { BlobService } from '../blob/blob.service';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentExtractionError } from './extractors/document-extractor';
import { PdfExtractor } from './extractors/pdf-extractor';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeIndexService } from './retrieval/knowledge-index.service';

vi.mock('@vercel/blob', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vercel/blob')>()),
  get: vi.fn(),
  del: vi.fn(),
}));
vi.mock('@vercel/blob/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vercel/blob/client')>()),
  generateClientTokenFromReadWriteToken: vi.fn(),
}));

const documentId = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
const pathname = `knowledge/${documentId}.pdf`;
const callbackUrl = 'https://api.vedora.vn/api/v1/webhooks/vercel-blob';

const waitingDocument: KnowledgeDocument = {
  id: documentId,
  uploadedById: '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2',
  title: 'dinh-duong.pdf',
  contentType: 'application/pdf',
  blobPathname: pathname,
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

  async function build(env: Record<string, unknown> = {}) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        KnowledgeService,
        BlobService,
        { provide: PrismaService, useValue: prisma },
        { provide: PdfExtractor, useValue: extractor },
        { provide: KnowledgeIndexService, useValue: index },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_store_secret',
            BLOB_CALLBACK_URL: callbackUrl,
            MAX_KNOWLEDGE_FILE_MB: 50,
            ...env,
          }),
        },
      ],
    }).compile();
    return moduleRef.get(KnowledgeService);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma = mockDeep<PrismaService>();
    extractor = mockDeep<PdfExtractor>();
    index = mockDeep<KnowledgeIndexService>();
    service = await build();
  });

  describe('createUpload', () => {
    it('scopes the client token to the new document and its callback', async () => {
      vi.mocked(generateClientTokenFromReadWriteToken).mockResolvedValue(
        'client-token',
      );
      prisma.knowledgeDocument.create.mockImplementation(
        ({ data }) => Promise.resolve({ ...waitingDocument, ...data }) as never,
      );

      const result = await service.createUpload(
        waitingDocument.uploadedById!,
        'Dinh Duong.PDF',
        1234,
      );

      expect(
        prisma.knowledgeDocument.create.mock.calls[0][0].data,
      ).toMatchObject({
        title: 'Dinh Duong.PDF',
        contentType: 'application/pdf',
      });
      expect(result.pathname).toMatch(/^knowledge\/[0-9a-f-]{36}\.pdf$/);
      expect(generateClientTokenFromReadWriteToken).toHaveBeenCalledWith(
        expect.objectContaining({
          pathname: result.pathname,
          allowedContentTypes: ['application/pdf'],
          maximumSizeInBytes: 50 * 1024 * 1024,
          onUploadCompleted: { callbackUrl, tokenPayload: result.document.id },
        }),
      );
      expect(result.clientToken).toBe('client-token');
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

    it('answers 503 without a callback URL to confirm uploads', async () => {
      service = await build({ BLOB_CALLBACK_URL: '' });

      await expect(service.createUpload('user', 'a.pdf', 1)).rejects.toThrow(
        'File storage callback is not configured',
      );
    });

    it('answers 503 without a Blob token', async () => {
      service = await build({ BLOB_READ_WRITE_TOKEN: '' });

      await expect(service.createUpload('user', 'a.pdf', 1)).rejects.toThrow(
        'File storage is not configured',
      );
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

      await service.markUploaded(pathname);

      expect(prisma.knowledgeDocument.updateManyAndReturn).toHaveBeenCalledWith(
        {
          where: {
            blobPathname: pathname,
            status: KnowledgeDocumentStatus.WAITING_UPLOAD,
          },
          data: { status: KnowledgeDocumentStatus.PROCESSING },
        },
      );
      expect(ingest).toHaveBeenCalledWith(processing);
    });

    it('does nothing when a retried callback finds it already moved on', async () => {
      prisma.knowledgeDocument.updateManyAndReturn.mockResolvedValue([]);
      const ingest = vi.spyOn(service, 'ingest');

      await service.markUploaded(pathname);

      expect(ingest).not.toHaveBeenCalled();
    });
  });

  describe('ingest', () => {
    const processing = {
      ...waitingDocument,
      status: KnowledgeDocumentStatus.PROCESSING,
    };

    beforeEach(() => {
      vi.mocked(get).mockResolvedValue({
        statusCode: 200,
        stream: new Blob(['%PDF-1.4']).stream(),
      } as never);
    });

    it('indexes the sections and marks the document READY', async () => {
      const sections = [
        { text: 'Trang 1', images: [new Uint8Array([1])] },
        { text: 'Trang 2', images: [] },
      ];
      extractor.extract.mockResolvedValue(sections);
      index.index.mockResolvedValue(1);

      await service.ingest(processing);

      expect(get).toHaveBeenCalledWith(pathname, {
        access: 'private',
        token: 'vercel_blob_rw_store_secret',
      });
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

    it('fails the document on unexpected errors', async () => {
      vi.mocked(get).mockRejectedValue(new Error('network down'));

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
    it('deletes the blob, the Qdrant points, then the row', async () => {
      prisma.knowledgeDocument.findUnique.mockResolvedValue(waitingDocument);

      await service.remove(documentId);

      expect(del).toHaveBeenCalledWith(pathname, {
        token: 'vercel_blob_rw_store_secret',
      });
      expect(index.remove).toHaveBeenCalledWith(documentId);
      expect(prisma.knowledgeDocument.delete).toHaveBeenCalledWith({
        where: { id: documentId },
      });
    });
  });
});
