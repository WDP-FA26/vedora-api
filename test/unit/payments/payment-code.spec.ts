import * as crypto from 'node:crypto';
import { generatePaymentCode } from '../../../src/payments/payment-code.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return {
    ...actual,
    randomInt: vi.fn(actual.randomInt),
  };
});

describe('generatePaymentCode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('produces prefix followed by 6 uppercase alphanumeric characters', () => {
    for (let i = 0; i < 20; i++) {
      const code = generatePaymentCode('VED');
      expect(code).toMatch(/^VED[0-9A-Z]{6}$/);
    }
  });

  it('preserves leading zeroes and supports upper/lower base36 boundaries', () => {
    const mockedRandomInt = vi.mocked(crypto.randomInt);
    mockedRandomInt.mockImplementationOnce(() => 0 as never);
    expect(generatePaymentCode('VED')).toBe('VED000000');
    expect(mockedRandomInt).toHaveBeenCalledWith(36 ** 6);

    mockedRandomInt.mockImplementationOnce(() => 35 as never);
    expect(generatePaymentCode('PAY')).toBe('PAY00000Z');

    mockedRandomInt.mockImplementationOnce(() => (36 ** 6 - 1) as never);
    expect(generatePaymentCode('VED')).toBe('VEDZZZZZZ');

    mockedRandomInt.mockImplementationOnce(() => 12345 as never);
    expect(generatePaymentCode('')).toBe('0009IX');
  });
});
