import type { Model } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Workspace } from '@src/mongo/models.js';
import { TaxCodeLookupStatus } from '@src/workspaces/dto/tax-code-lookup.dto.js';
import {
  isPublicTaxCode,
  legalNameMatches,
} from '@src/workspaces/tax-code-lookup.js';
import { TaxCodeLookupService } from '@src/workspaces/tax-code-lookup.service.js';

const VINGROUP = {
  code: '00',
  desc: 'Success - Thành công',
  data: {
    id: '0101245486',
    name: 'TẬP ĐOÀN VINGROUP - CÔNG TY CP',
    shortName: 'VINGROUP',
    address: 'Số 7, Đường Bằng Lăng 1, Phường Phúc Lợi, TP Hà Nội',
    status: 'NNT đang hoạt động',
  },
  metadata: { updatedAt: '2026-11-18T18:43:34.000Z' },
};

function answer(status: number, body: unknown) {
  return vi.fn(() => Promise.resolve(Response.json(body, { status })));
}

function service() {
  return new TaxCodeLookupService(mockDeep<Model<Workspace>>());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isPublicTaxCode', () => {
  it('accepts company codes only', () => {
    expect(isPublicTaxCode('0101245486')).toBe(true);
    expect(isPublicTaxCode('0101245486-001')).toBe(true);
    // Personal codes (citizen IDs) are not public.
    expect(isPublicTaxCode('001203004005')).toBe(false);
    expect(isPublicTaxCode('12345')).toBe(false);
  });
});

describe('legalNameMatches', () => {
  it('ignores accents, case, punctuation and how the legal form is written', () => {
    expect(
      legalNameMatches(
        'TẬP ĐOÀN VINGROUP - CÔNG TY CP',
        'Công ty cổ phần Vingroup',
      ),
    ).toBe(true);
    expect(
      legalNameMatches(
        'CÔNG TY TNHH NHÀ HÀNG CHAY SEN VIỆT',
        'Nha hang chay Sen Viet',
      ),
    ).toBe(true);
  });

  it('tells a different business apart', () => {
    expect(
      legalNameMatches(
        'CÔNG TY TNHH NHÀ HÀNG CHAY SEN VIỆT',
        'Công ty TNHH Bếp Chay Tâm An',
      ),
    ).toBe(false);
    expect(legalNameMatches('CÔNG TY CP', 'Công ty cổ phần')).toBe(false);
  });
});

describe('TaxCodeLookupService.lookUp', () => {
  it('returns the registration and keeps it for a day', async () => {
    const fetchMock = answer(200, VINGROUP);
    vi.stubGlobal('fetch', fetchMock);
    const lookups = service();

    const first = await lookups.lookUp('0101245486', 0);
    expect(first).toMatchObject({
      status: TaxCodeLookupStatus.FOUND,
      officialName: 'TẬP ĐOÀN VINGROUP - CÔNG TY CP',
      taxStatus: 'NNT đang hoạt động',
      sourceUpdatedAt: '2026-11-18T18:43:34.000Z',
    });
    await lookups.lookUp('0101245486', 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await lookups.lookUp('0101245486', 86_400_001);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports an unknown code', async () => {
    vi.stubGlobal(
      'fetch',
      answer(200, { code: '51', desc: 'Tax not found', data: null }),
    );
    const result = await service().lookUp('9900000001');
    expect(result.status).toBe(TaxCodeLookupStatus.NOT_FOUND);
  });

  it('does not keep a rate-limited answer', async () => {
    const fetchMock = answer(429, { message: 'Too many requests' });
    vi.stubGlobal('fetch', fetchMock);
    const lookups = service();

    const result = await lookups.lookUp('0101245486', 0);
    expect(result.status).toBe(TaxCodeLookupStatus.UNAVAILABLE);
    await lookups.lookUp('0101245486', 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a network failure as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('socket hang up'))),
    );
    const result = await service().lookUp('0101245486');
    expect(result.status).toBe(TaxCodeLookupStatus.UNAVAILABLE);
  });
});
