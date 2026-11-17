import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaymentStatus } from '../../../src/mongo/models.js';
import {
  AdminPaymentListDto,
  AdminPaymentPageDto,
  AdminPaymentQueryDto,
  AdminReceiptQueryDto,
  AdminSubscriptionQueryDto,
} from '../../../src/payments/admin/admin-payment-query.dto.js';

async function errorsFor<T extends object>(
  cls: new () => T,
  raw: Record<string, unknown>,
) {
  const dto = plainToInstance(cls, raw);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
}

describe('AdminPaymentQueryDto and related DTOs', () => {
  const validUuid = '00000000-0000-4000-8000-000000000001';

  describe('AdminPaymentQueryDto', () => {
    it('accepts empty and valid filter values', async () => {
      expect((await errorsFor(AdminPaymentQueryDto, {})).errors).toHaveLength(
        0,
      );
      expect(
        (
          await errorsFor(AdminPaymentQueryDto, {
            from: '2026-10-01',
            to: '2026-10-15',
            status: PaymentStatus.SUCCEEDED,
            plan: 'PLUS',
            userId: validUuid,
            q: 'VED7K9P2X',
          })
        ).errors,
      ).toHaveLength(0);
    });

    it('rejects invalid status, plan, userId, q length, and dates', async () => {
      for (const bad of [
        { status: 'EXPIRED' },
        { plan: 'PREMIUM' },
        { plan: 'FREE' },
        { userId: 'not-a-uuid' },
        { q: '' },
        { q: 'a'.repeat(201) },
        { from: '2026-10-1' },
        { to: '2026-02-30' },
        { unexpected: 'extra' },
      ]) {
        const { errors } = await errorsFor(AdminPaymentQueryDto, bad);
        expect(errors.length).toBeGreaterThan(0);
      }
    });
  });

  describe('AdminPaymentPageDto and AdminPaymentListDto', () => {
    it('applies defaults and transforms string query parameters to integers', async () => {
      const defaults = await errorsFor(AdminPaymentPageDto, {});
      expect(defaults.errors).toHaveLength(0);
      expect(defaults.dto.page).toBe(1);
      expect(defaults.dto.limit).toBe(25);

      const list = await errorsFor(AdminPaymentListDto, {
        page: '3',
        limit: '100',
        status: PaymentStatus.PENDING,
        plan: 'PRO',
      });
      expect(list.errors).toHaveLength(0);
      expect(list.dto.page).toBe(3);
      expect(list.dto.limit).toBe(100);
    });

    it('validates page and limit boundaries', async () => {
      expect(
        (
          await errorsFor(AdminPaymentListDto, {
            page: '100000',
            limit: '1',
          })
        ).errors,
      ).toHaveLength(0);

      for (const bad of [
        { page: '0' },
        { page: '100001' },
        { page: '1.5' },
        { limit: '0' },
        { limit: '101' },
        { limit: '2.5' },
      ]) {
        expect((await errorsFor(AdminPaymentPageDto, bad)).errors.length).toBeGreaterThan(0);
        expect((await errorsFor(AdminPaymentListDto, bad)).errors.length).toBeGreaterThan(0);
      }
    });
  });

  describe('AdminReceiptQueryDto', () => {
    it('accepts defaults and valid receipt filters', async () => {
      const res = await errorsFor(AdminReceiptQueryDto, {
        from: '2026-10-01',
        to: '2026-10-02',
        intentId: validUuid,
        outcome: 'CAPTURED',
        transactionId: 'BANK-123',
        unmatched: 'true',
        page: '2',
        limit: '50',
      });
      expect(res.errors).toHaveLength(0);
      expect(res.dto.page).toBe(2);
      expect(res.dto.limit).toBe(50);

      expect(
        (await errorsFor(AdminReceiptQueryDto, { unmatched: 'false' })).errors,
      ).toHaveLength(0);
    });

    it('rejects invalid receipt filters and pagination', async () => {
      for (const bad of [
        { intentId: 'bad' },
        { outcome: '' },
        { outcome: 'x'.repeat(101) },
        { transactionId: '' },
        { transactionId: 'x'.repeat(201) },
        { unmatched: 'yes' },
        { page: '0' },
        { limit: '101' },
      ]) {
        expect(
          (await errorsFor(AdminReceiptQueryDto, bad)).errors.length,
        ).toBeGreaterThan(0);
      }
    });
  });

  describe('AdminSubscriptionQueryDto', () => {
    it('accepts valid subscription filters and rejects invalid ones', async () => {
      expect(
        (
          await errorsFor(AdminSubscriptionQueryDto, {
            plan: 'PRO',
            userId: validUuid,
            page: '1',
            limit: '10',
          })
        ).errors,
      ).toHaveLength(0);

      for (const bad of [
        { plan: 'PREMIUM' },
        { userId: 'invalid' },
        { page: '0' },
        { limit: '101' },
      ]) {
        expect(
          (await errorsFor(AdminSubscriptionQueryDto, bad)).errors.length,
        ).toBeGreaterThan(0);
      }
    });
  });
});
