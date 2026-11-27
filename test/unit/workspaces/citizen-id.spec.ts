import { describe, expect, it } from 'vitest';

import { isWellFormedCitizenId } from '@src/workspaces/citizen-id.js';

const TODAY = new Date('2026-11-27T00:00:00Z');

describe('isWellFormedCitizenId', () => {
  it('accepts a number with a province code and a past birth year', () => {
    // Hà Nội, male, 1985.
    expect(isWellFormedCitizenId('001085012345', TODAY)).toBe(true);
    // TP.HCM, female, 2003.
    expect(isWellFormedCitizenId('079303012345', TODAY)).toBe(true);
    // Cà Mau, the last code; born this year.
    expect(isWellFormedCitizenId('096226012345', TODAY)).toBe(true);
  });

  it('rejects a code that is no province', () => {
    expect(isWellFormedCitizenId('000085012345', TODAY)).toBe(false);
    // 003 was skipped when the codes were assigned.
    expect(isWellFormedCitizenId('003085012345', TODAY)).toBe(false);
    expect(isWellFormedCitizenId('099085012345', TODAY)).toBe(false);
  });

  it('rejects a birth after today', () => {
    expect(isWellFormedCitizenId('001227012345', TODAY)).toBe(false);
    // 4 and above are births from 2100 on.
    expect(isWellFormedCitizenId('001485012345', TODAY)).toBe(false);
  });

  it('rejects anything but 12 digits', () => {
    expect(isWellFormedCitizenId('00108501234', TODAY)).toBe(false);
    expect(isWellFormedCitizenId('001 085 012 345', TODAY)).toBe(false);
    expect(isWellFormedCitizenId('0010850123a5', TODAY)).toBe(false);
  });
});
