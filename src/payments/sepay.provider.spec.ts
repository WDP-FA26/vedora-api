import Joi from 'joi';
import { ConfigService } from '@nestjs/config';
import { SePayProvider } from './sepay.provider';
import { sepayEnvironmentSchema } from './sepay.config';
import { parseBankWebhook } from './sepay-payload';

const config = {
  SEPAY_PAYMENT_ENABLED: true,
  SEPAY_QR_BANK_CODE: 'VCB',
  SEPAY_BANK_GATEWAY: 'Vietcombank',
  SEPAY_QR_ACCOUNT_NUMBER: '0012345678',
  SEPAY_QR_ACCOUNT_HOLDER: 'VEDORA TEST',
  SEPAY_QR_STORE_NAME: 'Vedora Test',
  SEPAY_QR_TRANSFER_PREFIX: 'VEDORA',
  SEPAY_BANK_WEBHOOK_API_KEY: 'sepay-test-webhook-secret',
};
const event = {
  id: 123,
  gateway: 'Vietcombank',
  accountNumber: '0012345678',
  transactionDate: '2026-10-23 00:00:00',
  code: 'VED7K9P2X',
  transferType: 'in',
  transferAmount: 49000,
};

describe('SePay provider boundary', () => {
  const provider = new SePayProvider(new ConfigService(config));
  it('encodes server snapshot and preserves leading zeroes in QR account', () => {
    const qr = provider.qr(provider.snapshot('VED7K9P2X'), '49000');
    const url = new URL(qr.imageUrl);
    expect(url.origin).toBe('https://vietqr.app');
    expect(url.searchParams.get('acc')).toBe('0012345678');
    expect(url.searchParams.get('des')).toBe('VEDORA VED7K9P2X');
    expect(url.searchParams.get('amount')).toBe('49000');
    expect(new URL(qr.downloadUrl).searchParams.get('download')).toBe('true');
  });
  it('accepts only correct Apikey credentials', () => {
    expect(() =>
      provider.verifyWebhook('Apikey sepay-test-webhook-secret'),
    ).not.toThrow();
    for (const value of [
      undefined,
      'Bearer sepay-test-webhook-secret',
      'Apikey x',
      'Apikey sepay-test-webhook-secreX',
      'Apikey sepay-test-webhook-secret extra',
    ])
      expect(() => provider.verifyWebhook(value)).toThrow();
  });
  it('disables payment creation and callbacks without configuration', () => {
    const disabled = new SePayProvider(
      new ConfigService({ SEPAY_PAYMENT_ENABLED: false }),
    );
    expect(() => disabled.snapshot('VEDABC')).toThrow();
    expect(() => disabled.verifyWebhook()).toThrow();
  });
  it('validates complete enabled configuration and server plan prices', () => {
    const schema = Joi.object(sepayEnvironmentSchema);
    expect(schema.validate(config).error).toBeUndefined();
    expect(
      schema.validate({ SEPAY_PAYMENT_ENABLED: true }).error,
    ).toBeDefined();
    expect(schema.validate({ BILLING_PRO_PRICE_VND: 0 }).error).toBeDefined();
    expect(schema.validate({ BILLING_PRO_PRICE_VND: 1.5 }).error).toBeDefined();
    expect(
      schema.validate({ SEPAY_PAYMENT_FLOW: 'gateway' }).error,
    ).toBeDefined();
  });
  it('parses Banking local time as UTC+7 and ignores nonessential provider fields', () => {
    const parsed = parseBankWebhook({
      ...event,
      accumulated: 10,
      content: 'Private sender details',
    });
    expect(parsed.paidAt.toISOString()).toBe('2026-10-22T17:00:00.000Z');
    expect(parsed.providerTransactionId).toBe('BANK-123');
    expect(parsed).not.toHaveProperty('content');
    expect(parsed).not.toHaveProperty('accumulated');
  });
  it.each([
    '2026-02-30 12:00:00',
    '2026-10-23 24:00:00',
    '2026-10-23T00:00:00Z',
    '0000-01-01 00:00:00',
  ])('rejects invalid provider time %s', (transactionDate) => {
    expect(() => parseBankWebhook({ ...event, transactionDate })).toThrow();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '49000'])(
    'rejects imprecise/nonpositive amount %s',
    (transferAmount) => {
      expect(() => parseBankWebhook({ ...event, transferAmount })).toThrow();
    },
  );
  it('does not extract a code from content when provider code is absent', () => {
    expect(
      parseBankWebhook({ ...event, code: null, content: 'VEDABC' }).code,
    ).toBeNull();
  });
});
