import type { Response } from 'express';
import { mockDeep } from 'vitest-mock-extended';
import { AdminAiCostsController } from '@src/admin-ai-costs/admin-ai-costs.controller.js';
import type { AdminAiCostsService } from '@src/admin-ai-costs/admin-ai-costs.service.js';
import { AiCostCallsQueryDto } from '@src/admin-ai-costs/ai-cost-query.dto.js';

describe('AdminAiCostsController', () => {
  let service: ReturnType<typeof mockDeep<AdminAiCostsService>>;
  let controller: AdminAiCostsController;

  beforeEach(() => {
    service = mockDeep<AdminAiCostsService>();
    controller = new AdminAiCostsController(service);
  });

  it('delegates report, list, and reconcile to AdminAiCostsService', async () => {
    const reportResult = {
      currency: 'USD',
    } as unknown as Awaited<ReturnType<AdminAiCostsService['report']>>;
    const listResult = {
      items: [],
      total: 0,
      page: 1,
      limit: 50,
    } as unknown as Awaited<ReturnType<AdminAiCostsService['list']>>;
    const reconcileResult = {
      id: 'call-1',
    } as unknown as Awaited<ReturnType<AdminAiCostsService['reconcile']>>;

    service.report.mockResolvedValue(reportResult);
    service.list.mockResolvedValue(listResult);
    service.reconcile.mockResolvedValue(reconcileResult);

    const query = { feature: 'KNOWLEDGE' };
    await expect(controller.report(query)).resolves.toBe(reportResult);
    expect(service.report).toHaveBeenCalledExactlyOnceWith(query);

    const callsQuery = new AiCostCallsQueryDto();
    await expect(controller.list(callsQuery)).resolves.toBe(listResult);
    expect(service.list).toHaveBeenCalledExactlyOnceWith(callsQuery);

    const callId = '00000000-0000-4000-8000-000000000001';
    await expect(controller.reconcile(callId)).resolves.toBe(reconcileResult);
    expect(service.reconcile).toHaveBeenCalledExactlyOnceWith(callId);
  });

  it('sets CSV content type and attachment filename on export', async () => {
    service.csv.mockResolvedValue('\ufeff"id"\r\n"1"');
    const send = vi.fn();
    const attachment = vi.fn().mockReturnValue({ send });
    const type = vi.fn().mockReturnValue({ attachment });
    const response = { type } as unknown as Response;

    await controller.csv({ model: 'actual/model' }, response);

    expect(service.csv).toHaveBeenCalledExactlyOnceWith({
      model: 'actual/model',
    });
    expect(type).toHaveBeenCalledExactlyOnceWith('text/csv');
    expect(attachment).toHaveBeenCalledExactlyOnceWith('vedora-ai-costs.csv');
    expect(send).toHaveBeenCalledExactlyOnceWith('\ufeff"id"\r\n"1"');
  });
});
