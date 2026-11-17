import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '../../../../src/auth-core/auth.types.js';
import type { PaginatedResponseDto } from '../../../../src/common/pagination/index.js';
import { PostReportStatus, UserRole } from '../../../../src/mongo/models.js';
import { AdminReportsController } from '../../../../src/posts/admin/admin-reports.controller.js';
import type { AdminPostReportDto } from '../../../../src/posts/dto/post-interaction.dto.js';
import type { PostReportsService } from '../../../../src/posts/interactions/post-reports.service.js';

describe('AdminReportsController', () => {
  const adminId = '11111111-1111-4111-8111-111111111111';
  const reportId = '22222222-2222-4222-8222-222222222222';
  const adminReq = {
    user: { sub: adminId, username: 'admin', role: UserRole.ADMIN },
  } as AuthenticatedRequest;

  let reports: DeepMockProxy<PostReportsService>;
  let controller: AdminReportsController;

  beforeEach(() => {
    reports = mockDeep<PostReportsService>();
    controller = new AdminReportsController(reports);
  });

  it('delegates findAll and review to PostReportsService', async () => {
    const page = {
      items: [],
      meta: {
        page: 1,
        limit: 20,
        totalItems: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    } as PaginatedResponseDto<AdminPostReportDto>;
    const dto = { id: reportId } as AdminPostReportDto;
    reports.findAll.mockResolvedValue(page);
    reports.review.mockResolvedValue(dto);

    await expect(
      controller.findAll({ page: 1, limit: 20, status: PostReportStatus.PENDING }),
    ).resolves.toBe(page);
    expect(reports.findAll).toHaveBeenCalledWith({
      page: 1,
      limit: 20,
      status: PostReportStatus.PENDING,
    });

    await expect(
      controller.review(adminReq, reportId, { status: PostReportStatus.RESOLVED }),
    ).resolves.toBe(dto);
    expect(reports.review).toHaveBeenCalledWith(
      reportId,
      adminId,
      PostReportStatus.RESOLVED,
    );
  });
});
