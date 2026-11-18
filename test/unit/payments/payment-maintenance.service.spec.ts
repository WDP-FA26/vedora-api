import { Logger } from '@nestjs/common';
import { PaymentMaintenanceService } from '../../../src/payments/payment-maintenance.service.js';
import type { PaymentsService } from '../../../src/payments/payments.service.js';

describe('payment expiration maintenance', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sweeps overdue orders on startup, including after downtime', async () => {
    const expirePending = vi.fn().mockResolvedValue(2);
    const service = new PaymentMaintenanceService({
      expirePending,
    } as unknown as PaymentsService);
    await service.onApplicationBootstrap();
    expect(expirePending).toHaveBeenCalledOnce();
  });

  it('logs a failed sweep and can recover on the next invocation', async () => {
    const expirePending = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(1);
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const service = new PaymentMaintenanceService({
      expirePending,
    } as unknown as PaymentsService);
    await expect(service.expireOrders()).resolves.toBeUndefined();
    await expect(service.expireOrders()).resolves.toBeUndefined();
    expect(expirePending).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledOnce();
  });
});
