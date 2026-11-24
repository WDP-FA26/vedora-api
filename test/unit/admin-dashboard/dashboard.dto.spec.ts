import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  DashboardQueryDto,
  UNAVAILABLE_DASHBOARD_METRICS,
} from '@src/admin-dashboard/dto/dashboard.dto.js';

describe('DashboardQueryDto', () => {
  it('accepts an empty query and valid YYYY-MM-DD dates', async () => {
    await expect(
      validate(plainToInstance(DashboardQueryDto, {})),
    ).resolves.toHaveLength(0);
    await expect(
      validate(
        plainToInstance(DashboardQueryDto, {
          from: '2026-10-01',
          to: '2026-10-23',
        }),
      ),
    ).resolves.toHaveLength(0);
  });

  it.each([
    { from: '2026-1-01', to: '2026-10-23' },
    { from: '2026-10-01T00:00:00Z', to: '2026-10-23' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-10-01', to: 'not-a-date' },
  ])('rejects invalid date inputs: %j', async (input) => {
    await expect(
      validate(plainToInstance(DashboardQueryDto, input)),
    ).resolves.not.toHaveLength(0);
  });

  it('exposes the fixed unavailable metric codes', () => {
    expect(UNAVAILABLE_DASHBOARD_METRICS).toEqual([
      'MODERATION_CASE_SEVERITY',
      'CONTENT_APPROVALS',
      'PAYMENT_DEMO',
    ]);
  });
});
