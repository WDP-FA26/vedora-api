import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AiCostCallsQueryDto,
  AiCostQueryDto,
} from '../../../src/admin-ai-costs/ai-cost-query.dto.js';
import { AI_COST_FEATURES } from '../../../src/ai/telemetry/ai-cost-context.js';

describe('AI cost query DTOs', () => {
  describe('AiCostQueryDto', () => {
    it('accepts valid feature, model, and date filters', async () => {
      for (const feature of AI_COST_FEATURES) {
        const dto = plainToInstance(AiCostQueryDto, {
          from: '2026-10-01',
          to: '2026-10-05',
          feature,
          model: 'google/gemini-2.5-flash',
        });
        await expect(validate(dto)).resolves.toHaveLength(0);
      }
    });

    it('rejects unknown features and overlong or non-string models', async () => {
      await expect(
        validate(plainToInstance(AiCostQueryDto, { feature: 'UNKNOWN' })),
      ).resolves.not.toHaveLength(0);
      await expect(
        validate(plainToInstance(AiCostQueryDto, { model: 'm'.repeat(201) })),
      ).resolves.not.toHaveLength(0);
      await expect(
        validate(plainToInstance(AiCostQueryDto, { model: 42 })),
      ).resolves.not.toHaveLength(0);
    });
  });

  describe('AiCostCallsQueryDto', () => {
    it('defaults page=1 and limit=50 and transforms numeric strings', async () => {
      const defaults = plainToInstance(AiCostCallsQueryDto, {});
      expect(defaults.page).toBe(1);
      expect(defaults.limit).toBe(50);
      await expect(validate(defaults)).resolves.toHaveLength(0);

      const transformed = plainToInstance(AiCostCallsQueryDto, {
        page: '3',
        limit: '100',
      });
      expect(transformed.page).toBe(3);
      expect(transformed.limit).toBe(100);
      await expect(validate(transformed)).resolves.toHaveLength(0);
    });

    it.each([
      { page: 0 },
      { page: 100_001 },
      { page: 1.5 },
      { limit: 0 },
      { limit: 101 },
      { limit: 10.2 },
    ])('rejects out-of-bounds pagination: %j', async (input) => {
      await expect(
        validate(plainToInstance(AiCostCallsQueryDto, input)),
      ).resolves.not.toHaveLength(0);
    });
  });
});
