import { paymentCodesFromContent } from './payment-code';

describe('Payment code recovery from transfer content', () => {
  const code = 'VED0123456789ABCDEF0123';
  it('recovers the wallet spacing pattern without retaining sender information', () => {
    expect(
      paymentCodesFromContent(
        '123456-0000000000-VED012345 6789ABCDEF0123 CKN 123456 - VI DIEN TU',
        'VED',
      ),
    ).toEqual([code]);
  });
  it.each([
    code,
    code.toLowerCase(),
    'VED 0123456789ABCDEF0123',
    'VED012345\t6789ABCDEF0123',
    'VED0 1 2 3 4 5 6 7 8 9 A B C D E F 0 1 2 3',
    `-${code} CKN 123456`,
    `${code} FT12345678901234 CKN 123456`,
  ])('accepts one complete code with allowed boundaries: %s', (content) => {
    expect(paymentCodesFromContent(content, 'VED')).toEqual([code]);
  });
  it.each([
    'VED0123456789ABCDEF012', // missing last character
    'VED0123456789ABCDEF012 CKN 123456',
    `${code}4`,
    `${code} 4 CKN 123456`,
    `${code} ABC CKN 123456`,
    `${code.toLowerCase()} abc CKN 123456`,
    `${code}G`,
    `X${code}`,
    'VED012345-6789ABCDEF0123',
    'VED012345/6789ABCDEF0123',
    'VED012345\n6789ABCDEF0123',
    'VED012345\u00a06789ABCDEF0123',
    'VED012345    6789ABCDEF0123',
    'VED0123456789ABCDEFO123', // letter O is not zero
    'VED0123456789ABCDEF01ﬀ', // Unicode ligature must not expand into ASCII FF
    'VED012345 TEXT 6789ABCDEF0123',
  ])('rejects truncated/extended/fuzzy code: %s', (content) => {
    expect(paymentCodesFromContent(content, 'VED')).toEqual([]);
  });
  it('reports two different candidates instead of choosing a matching amount or first code', () => {
    expect(
      paymentCodesFromContent(`${code} VEDFEDCBA9876543210FEDC`, 'VED'),
    ).toHaveLength(2);
  });
  it('deduplicates repeated occurrences of the same complete code', () => {
    expect(
      paymentCodesFromContent(`${code} / VED012345 6789ABCDEF0123`, 'VED'),
    ).toEqual([code]);
  });
  it('uses the configured prefix without assuming VED or allowing regex injection', () => {
    expect(paymentCodesFromContent('PAY012345 6789ABCDEF0123', 'PAY')).toEqual([
      'PAY0123456789ABCDEF0123',
    ]);
    expect(paymentCodesFromContent(code, 'PAY')).toEqual([]);
    expect(paymentCodesFromContent(code, '.*')).toEqual([]);
  });
  it('bounds input size and treats absent content as no code', () => {
    expect(paymentCodesFromContent(undefined, 'VED')).toEqual([]);
    expect(paymentCodesFromContent(null, 'VED')).toEqual([]);
    expect(
      paymentCodesFromContent(`${code}${' '.repeat(4096)}`, 'VED'),
    ).toEqual([]);
  });
});
