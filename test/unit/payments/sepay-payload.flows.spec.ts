import { InvalidInputException } from '@src/common/exceptions/invalid-input.exception.js';
import { parseBankWebhook } from '@src/payments/sepay-payload.js';

const valid = {
  id: 9001,
  gateway: 'Vietcombank',
  accountNumber: '0012345678',
  transactionDate: '2026-11-17 09:30:00',
  code: 'VED7K9P2X',
  transferType: 'in',
  transferAmount: 49000,
  referenceCode: 'FT123',
};

describe('SePay Banking payload boundaries (contract matrix)', () => {
  describe('transaction id', () => {
    it.each([
      [1, 'BANK-1'],
      ['1', 'BANK-1'],
      ['9'.repeat(30), `BANK-${'9'.repeat(30)}`],
    ])('accepts id %s as provider transaction %s', (id, expected) => {
      expect(parseBankWebhook({ ...valid, id }).providerTransactionId).toBe(
        expected,
      );
    });

    it.each([0, '0', '01', '9'.repeat(31), -5, 'abc', null])(
      'rejects id %s',
      (id) => {
        expect(() => parseBankWebhook({ ...valid, id })).toThrow(
          InvalidInputException,
        );
      },
    );
  });

  describe('amount', () => {
    it('accepts the minimum positive amount of 1 VND', () => {
      expect(
        parseBankWebhook({ ...valid, transferAmount: 1 }).transferAmount,
      ).toBe(1);
    });

    it('accepts the largest safe integer amount', () => {
      const parsed = parseBankWebhook({
        ...valid,
        transferAmount: Number.MAX_SAFE_INTEGER,
      });

      expect(parsed.transferAmount).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('rejects a missing amount', () => {
      const { transferAmount: _omit, ...withoutAmount } = valid;

      expect(() => parseBankWebhook(withoutAmount)).toThrow(
        InvalidInputException,
      );
    });
  });

  describe('transaction date (UTC+7)', () => {
    it('converts the last second of a Bangkok day to the previous-day UTC time', () => {
      const parsed = parseBankWebhook({
        ...valid,
        transactionDate: '2026-01-01 06:59:59',
      });

      expect(parsed.paidAt.toISOString()).toBe('2025-12-31T23:59:59.000Z');
    });

    it('accepts 29 February in a leap year', () => {
      const parsed = parseBankWebhook({
        ...valid,
        transactionDate: '2028-02-29 12:00:00',
      });

      expect(parsed.paidAt.toISOString()).toBe('2028-02-29T05:00:00.000Z');
    });

    it.each([
      '2026-02-29 12:00:00',
      '2026-11-17 09:30:60',
      '2026-11-17 9:30:00',
      '2026-13-01 00:00:00',
      '',
    ])('rejects malformed date %s', (transactionDate) => {
      expect(() => parseBankWebhook({ ...valid, transactionDate })).toThrow(
        InvalidInputException,
      );
    });
  });

  describe('identity fields', () => {
    it.each(['', 'x'.repeat(101)])(
      'rejects gateway of invalid length (%#)',
      (gateway) => {
        expect(() => parseBankWebhook({ ...valid, gateway })).toThrow(
          InvalidInputException,
        );
      },
    );

    it('accepts a gateway of exactly 100 characters', () => {
      const gateway = 'g'.repeat(100);

      expect(parseBankWebhook({ ...valid, gateway }).gateway).toBe(gateway);
    });

    it('rejects a code longer than 100 characters', () => {
      expect(() =>
        parseBankWebhook({ ...valid, code: 'C'.repeat(101) }),
      ).toThrow(InvalidInputException);
    });

    it('keeps an omitted code as absent so the service records PAYMENT_CODE_MISSING', () => {
      const { code: _omit, ...withoutCode } = valid;

      expect(parseBankWebhook(withoutCode).code).toBeUndefined();
    });

    it('preserves leading zeroes in the account number', () => {
      expect(parseBankWebhook(valid).accountNumber).toBe('0012345678');
    });

    it.each(['IN', 'In', 'incoming'])(
      'rejects transferType %s outside the documented in/out values',
      (transferType) => {
        expect(() => parseBankWebhook({ ...valid, transferType })).toThrow(
          InvalidInputException,
        );
      },
    );
  });

  describe('body shape', () => {
    it.each([null, [], 'text', 42])('rejects a non-object body %s', (body) => {
      expect(() => parseBankWebhook(body)).toThrow(InvalidInputException);
    });
  });
});
