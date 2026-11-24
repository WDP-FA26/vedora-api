import type { Response } from 'express';
import { mockDeep } from 'vitest-mock-extended';
import {
  AdminPaymentListDto,
  AdminPaymentPageDto,
  AdminPaymentQueryDto,
  AdminReceiptQueryDto,
  AdminSubscriptionQueryDto,
} from '@src/payments/admin/admin-payment-query.dto.js';
import { AdminPaymentsController } from '@src/payments/admin/admin-payments.controller.js';
import type { AdminPaymentsService } from '@src/payments/admin/admin-payments.service.js';

describe('AdminPaymentsController', () => {
  const intentId = '00000000-0000-4000-8000-000000000002';
  let service: ReturnType<typeof mockDeep<AdminPaymentsService>>;
  let controller: AdminPaymentsController;

  beforeEach(() => {
    service = mockDeep<AdminPaymentsService>();
    controller = new AdminPaymentsController(service);
  });

  it('delegates overview() to AdminPaymentsService.overview', async () => {
    const query = new AdminPaymentQueryDto();
    const expected = { currency: 'VND' } as never;
    service.overview.mockResolvedValue(expected);

    await expect(controller.overview(query)).resolves.toBe(expected);
    expect(service.overview).toHaveBeenCalledExactlyOnceWith(query);
  });

  it('delegates orders() to AdminPaymentsService.orders', async () => {
    const query = new AdminPaymentListDto();
    const expected = { items: [], total: 0, page: 1, limit: 25 } as never;
    service.orders.mockResolvedValue(expected);

    await expect(controller.orders(query)).resolves.toBe(expected);
    expect(service.orders).toHaveBeenCalledExactlyOnceWith(query);
  });

  it('delegates detail() to AdminPaymentsService.detail', async () => {
    const expected = { order: { id: intentId } } as never;
    service.detail.mockResolvedValue(expected);

    await expect(controller.detail(intentId)).resolves.toBe(expected);
    expect(service.detail).toHaveBeenCalledExactlyOnceWith(intentId);
  });

  it('delegates orderReceipts() to AdminPaymentsService.orderReceipts', async () => {
    const query = new AdminPaymentPageDto();
    const expected = { items: [], total: 0, page: 1, limit: 25 } as never;
    service.orderReceipts.mockResolvedValue(expected);

    await expect(controller.orderReceipts(intentId, query)).resolves.toBe(
      expected,
    );
    expect(service.orderReceipts).toHaveBeenCalledExactlyOnceWith(
      intentId,
      query,
    );
  });

  it('delegates receipts() to AdminPaymentsService.receiptsPage', async () => {
    const query = new AdminReceiptQueryDto();
    const expected = { items: [], total: 0, page: 1, limit: 25 } as never;
    service.receiptsPage.mockResolvedValue(expected);

    await expect(controller.receipts(query)).resolves.toBe(expected);
    expect(service.receiptsPage).toHaveBeenCalledExactlyOnceWith(query);
  });

  it('delegates subscriptions() to AdminPaymentsService.activeSubscriptions', async () => {
    const query = new AdminSubscriptionQueryDto();
    const expected = { items: [], total: 0, page: 1, limit: 25 } as never;
    service.activeSubscriptions.mockResolvedValue(expected);

    await expect(controller.subscriptions(query)).resolves.toBe(expected);
    expect(service.activeSubscriptions).toHaveBeenCalledExactlyOnceWith(query);
  });

  it('exports CSV with text/csv type and vedora-payments.csv attachment', async () => {
    const query = new AdminPaymentQueryDto();
    service.export.mockResolvedValue('\ufeff"id"\r\n');
    const response = {
      type: vi.fn().mockReturnThis(),
      attachment: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as unknown as Response;

    await controller.export(query, response);

    expect(service.export).toHaveBeenCalledExactlyOnceWith(query);
    expect(response.type).toHaveBeenCalledExactlyOnceWith('text/csv');
    expect(response.attachment).toHaveBeenCalledExactlyOnceWith(
      'vedora-payments.csv',
    );
    expect(response.send).toHaveBeenCalledExactlyOnceWith('\ufeff"id"\r\n');
  });
});
