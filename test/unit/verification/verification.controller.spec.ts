import { mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '@src/auth-core/auth.types.js';
import type { PaginatedResponseDto } from '@src/common/pagination/index.js';
import { UserRole, VerificationStatus } from '@src/mongo/models.js';
import type {
  AdminVerificationRequestDetailDto,
  AdminVerificationRequestDto,
  CreateProofUploadDto,
  CreateVerificationRequestDto,
  MyVerificationDto,
  ProofUploadDto,
  ReviewVerificationRequestDto,
  VerificationRequestDto,
} from '@src/verification/dto/verification.dto.js';
import { VerificationController } from '@src/verification/verification.controller.js';
import type { VerificationService } from '@src/verification/verification.service.js';

describe('VerificationController', () => {
  const userId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
  const adminId = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
  const requestId = 'b7f6f651-b0fc-43a5-b589-edbda60e5983';
  const proofId = 'c2b9a8f4-6f0b-4a8b-9d53-6c3f2f1f2a11';

  const userRequest = {
    user: { sub: userId, username: 'vedora.chef', role: UserRole.USER },
  } as AuthenticatedRequest;
  const adminRequest = {
    user: { sub: adminId, username: 'vedora.admin', role: UserRole.ADMIN },
  } as AuthenticatedRequest;

  let service: ReturnType<typeof mockDeep<VerificationService>>;
  let controller: VerificationController;

  beforeEach(() => {
    service = mockDeep<VerificationService>();
    controller = new VerificationController(service);
  });

  it('delegates mine() with caller sub', async () => {
    const mine: MyVerificationDto = { isProfessional: false, request: null };
    service.mine.mockResolvedValue(mine);

    await expect(controller.mine(userRequest)).resolves.toBe(mine);
    expect(service.mine).toHaveBeenCalledExactlyOnceWith(userId);
  });

  it('delegates createProofUpload() with caller sub and dto', async () => {
    const dto: CreateProofUploadDto = {
      contentType: 'image/png',
      sizeBytes: 2048,
    };
    const upload: ProofUploadDto = {
      id: proofId,
      upload: {
        url: 'https://storage/put',
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        expiresAt: new Date('2026-10-01T01:00:00Z'),
      },
    };
    service.createProofUpload.mockResolvedValue(upload);

    await expect(controller.createProofUpload(userRequest, dto)).resolves.toBe(
      upload,
    );
    expect(service.createProofUpload).toHaveBeenCalledExactlyOnceWith(
      userId,
      dto,
    );
  });

  it('delegates submit() with caller sub and dto', async () => {
    const dto: CreateVerificationRequestDto = {
      statement: 'Executive chef at Green Leaf Bistro since 2020.',
      proofIds: [proofId],
    };
    const created: VerificationRequestDto = {
      id: requestId,
      statement: dto.statement,
      status: VerificationStatus.PENDING,
      reviewNote: null,
      reviewedAt: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      proofCount: 1,
    };
    service.submit.mockResolvedValue(created);

    await expect(controller.submit(userRequest, dto)).resolves.toBe(created);
    expect(service.submit).toHaveBeenCalledExactlyOnceWith(userId, dto);
  });

  it('delegates findAll() with query', async () => {
    const query = { page: 1, limit: 20, status: VerificationStatus.PENDING };
    const page: PaginatedResponseDto<AdminVerificationRequestDto> = {
      items: [],
      meta: {
        page: 1,
        limit: 20,
        totalItems: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    };
    service.findAll.mockResolvedValue(page);

    await expect(controller.findAll(query)).resolves.toBe(page);
    expect(service.findAll).toHaveBeenCalledExactlyOnceWith(query);
  });

  it('delegates findOne() with request id', async () => {
    const detail = { id: requestId } as AdminVerificationRequestDetailDto;
    service.findOne.mockResolvedValue(detail);

    await expect(controller.findOne(requestId)).resolves.toBe(detail);
    expect(service.findOne).toHaveBeenCalledExactlyOnceWith(requestId);
  });

  it('delegates review() with request id, admin sub, and dto', async () => {
    const dto: ReviewVerificationRequestDto = {
      decision: VerificationStatus.REJECTED,
      note: 'Blurry certificate',
    };
    const reviewed = {
      id: requestId,
      status: VerificationStatus.REJECTED,
    } as AdminVerificationRequestDto;
    service.review.mockResolvedValue(reviewed);

    await expect(controller.review(adminRequest, requestId, dto)).resolves.toBe(
      reviewed,
    );
    expect(service.review).toHaveBeenCalledExactlyOnceWith(
      requestId,
      adminId,
      dto,
    );
  });
});
