import { mockDeep } from 'vitest-mock-extended';
import { AdminDashboardController } from '@src/admin-dashboard/admin-dashboard.controller.js';
import type { AdminDashboardService } from '@src/admin-dashboard/admin-dashboard.service.js';
import type { DashboardDto } from '@src/admin-dashboard/dto/dashboard.dto.js';

describe('AdminDashboardController', () => {
  it('delegates get() with query to AdminDashboardService', async () => {
    const service = mockDeep<AdminDashboardService>();
    const expected = {
      generatedAt: '2026-10-23T05:00:00.000Z',
    } as unknown as DashboardDto;
    service.get.mockResolvedValue(expected);
    const controller = new AdminDashboardController(service);

    const query = { from: '2026-10-01', to: '2026-10-23' };
    await expect(controller.get(query)).resolves.toBe(expected);
    expect(service.get).toHaveBeenCalledExactlyOnceWith(query);
  });
});
