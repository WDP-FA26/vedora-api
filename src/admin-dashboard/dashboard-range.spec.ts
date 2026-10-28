import { resolveDashboardRange } from './dashboard-range.js';

describe('Dashboard Bangkok calendar range', () => {
  it('defaults to 30 inclusive days using Bangkok midnight rather than UTC date', () => {
    const range = resolveDashboardRange({}, new Date('2026-10-22T17:00:00Z'));
    expect(range).toMatchObject({
      from: '2026-09-24',
      to: '2026-10-23',
      dayCount: 30,
      timeZone: 'Asia/Bangkok',
    });
    expect(range.start.toISOString()).toBe('2026-09-23T17:00:00.000Z');
    expect(range.endExclusive.toISOString()).toBe('2026-10-23T17:00:00.000Z');
  });

  it('does not advance the date before midnight in Bangkok', () => {
    expect(
      resolveDashboardRange({}, new Date('2026-10-22T16:59:59.999Z')).to,
    ).toBe('2026-10-22');
  });

  it('accepts exactly 90 inclusive days and a leap day', () => {
    expect(
      resolveDashboardRange({ from: '2024-01-01', to: '2024-03-30' }).dayCount,
    ).toBe(90);
    expect(
      resolveDashboardRange({ from: '2024-02-29', to: '2024-02-29' }).dayCount,
    ).toBe(1);
  });

  it.each([
    { from: '2026-10-01' },
    { to: '2026-10-01' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-02-29', to: '2026-03-01' },
    { from: '2026-10-02', to: '2026-10-01' },
    { from: '2024-01-01', to: '2024-03-31' },
    { from: '2026-1-01', to: '2026-01-01' },
    { from: '0000-01-01', to: '0000-01-01' },
    { from: 'invalid', to: '2026-10-01' },
  ])('rejects invalid or partial ranges: %j', (query) => {
    expect(() => resolveDashboardRange(query)).toThrow('Provide both from/to');
  });
});
