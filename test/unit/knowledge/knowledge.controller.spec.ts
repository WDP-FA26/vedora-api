import { mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '@src/auth-core/auth.types.js';
import type {
  CreateKnowledgeUploadResponseDto,
  KnowledgeDocumentResponseDto,
  KnowledgeFileUrlResponseDto,
  KnowledgePageResponseDto,
} from '@src/knowledge/dto/knowledge-document-response.dto.js';
import { KnowledgeController } from '@src/knowledge/knowledge.controller.js';
import type { KnowledgeService } from '@src/knowledge/knowledge.service.js';
import { UserRole } from '@src/mongo/models.js';

describe('KnowledgeController', () => {
  const adminId = '00000000-0000-4000-8000-000000000001';
  const docId = '00000000-0000-4000-8000-000000000002';
  const request = {
    user: { sub: adminId, username: 'vedora.admin', role: UserRole.ADMIN },
  } as AuthenticatedRequest;

  let service: ReturnType<typeof mockDeep<KnowledgeService>>;
  let controller: KnowledgeController;

  beforeEach(() => {
    service = mockDeep<KnowledgeService>();
    controller = new KnowledgeController(service);
  });

  it('delegates createUpload with authenticated admin sub, filename, and sizeBytes', async () => {
    const upload = {
      id: docId,
      uploadUrl: 'https://storage.local/upload',
    } as unknown as CreateKnowledgeUploadResponseDto;
    service.createUpload.mockResolvedValue(upload);

    await expect(
      controller.createUpload(request, {
        filename: 'nutrition.pdf',
        sizeBytes: 12345,
      }),
    ).resolves.toBe(upload);
    expect(service.createUpload).toHaveBeenCalledExactlyOnceWith(
      adminId,
      'nutrition.pdf',
      12345,
    );
  });

  it('delegates findAll and findOne', async () => {
    const doc = { id: docId } as unknown as KnowledgeDocumentResponseDto;
    service.findAll.mockResolvedValue([doc]);
    service.findOne.mockResolvedValue(doc);

    await expect(controller.findAll()).resolves.toEqual([doc]);
    expect(service.findAll).toHaveBeenCalledOnce();

    await expect(controller.findOne(docId)).resolves.toBe(doc);
    expect(service.findOne).toHaveBeenCalledExactlyOnceWith(docId);
  });

  it('delegates listPages, updatePage, and fileUrl', async () => {
    const page = {
      page: 1,
      text: 'Corrected',
      flags: [],
      edited: true,
    } as unknown as KnowledgePageResponseDto;
    const fileUrl = {
      url: 'https://storage.local/doc.pdf',
      expiresAt: '2026-11-17T00:15:00.000Z',
    } as unknown as KnowledgeFileUrlResponseDto;
    service.listPages.mockResolvedValue([page]);
    service.updatePage.mockResolvedValue(page);
    service.fileUrl.mockResolvedValue(fileUrl);

    await expect(controller.listPages(docId)).resolves.toEqual([page]);
    expect(service.listPages).toHaveBeenCalledExactlyOnceWith(docId);

    await expect(
      controller.updatePage(docId, 2, { text: 'Corrected' }),
    ).resolves.toBe(page);
    expect(service.updatePage).toHaveBeenCalledExactlyOnceWith(
      docId,
      2,
      'Corrected',
    );

    await expect(controller.fileUrl(docId)).resolves.toBe(fileUrl);
    expect(service.fileUrl).toHaveBeenCalledExactlyOnceWith(docId);
  });

  it('delegates approve and reject with note or null fallback', async () => {
    const doc = { id: docId } as unknown as KnowledgeDocumentResponseDto;
    service.approve.mockResolvedValue(doc);
    service.reject.mockResolvedValue(doc);

    await expect(controller.approve(request, docId, {})).resolves.toBe(doc);
    expect(service.approve).toHaveBeenLastCalledWith(adminId, docId, null);

    await expect(
      controller.approve(request, docId, { note: 'Verified' }),
    ).resolves.toBe(doc);
    expect(service.approve).toHaveBeenLastCalledWith(
      adminId,
      docId,
      'Verified',
    );

    await expect(controller.reject(request, docId, {})).resolves.toBe(doc);
    expect(service.reject).toHaveBeenLastCalledWith(adminId, docId, null);

    await expect(
      controller.reject(request, docId, { note: 'Corrupt OCR' }),
    ).resolves.toBe(doc);
    expect(service.reject).toHaveBeenLastCalledWith(
      adminId,
      docId,
      'Corrupt OCR',
    );
  });

  it('delegates reopen and remove', async () => {
    const doc = { id: docId } as unknown as KnowledgeDocumentResponseDto;
    service.reopen.mockResolvedValue(doc);
    service.remove.mockResolvedValue(undefined);

    await expect(controller.reopen(docId)).resolves.toBe(doc);
    expect(service.reopen).toHaveBeenCalledExactlyOnceWith(docId);

    await expect(controller.remove(docId)).resolves.toBeUndefined();
    expect(service.remove).toHaveBeenCalledExactlyOnceWith(docId);
  });
});
