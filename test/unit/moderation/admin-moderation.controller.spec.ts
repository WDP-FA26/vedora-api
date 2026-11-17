import { describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '../../../src/auth-core/auth.types.js';
import { FeatureUnavailableException } from '../../../src/common/exceptions/feature-unavailable.exception.js';
import { StateConflictException } from '../../../src/common/exceptions/state-conflict.exception.js';
import { AdminModerationController } from '../../../src/moderation/admin-moderation.controller.js';
import { ContentModerationService } from '../../../src/moderation/content-moderation.service.js';
import type {
  TestModerationDto,
  UpdateModerationSettingsDto,
} from '../../../src/moderation/dto/moderation-settings.dto.js';
import {
  type ContentSettings,
  ModerationSettingsService,
} from '../../../src/moderation/moderation-settings.service.js';
import { UserRole } from '../../../src/mongo/models.js';

function makeSettings(overrides: Partial<ContentSettings> = {}): ContentSettings {
  return {
    instructions: 'Classify content safely for plant-based cooking.',
    allowDescription: 'Everyday cooking posts and friendly questions.',
    choices: [
      {
        key: 'hate',
        label: 'Thù ghét',
        reasonText: 'ngôn từ thù ghét',
        description: 'Attacks or dehumanises people or groups.',
      },
    ],
    rejectThreshold: 0.85,
    reviewThreshold: 0.3,
    version: 0,
    updatedById: null,
    updatedAt: null,
    ...overrides,
  };
}

const adminRequest = {
  user: { sub: 'admin-1', username: 'vedora.admin', role: UserRole.ADMIN },
} as AuthenticatedRequest;

describe('AdminModerationController', () => {
  it('marks built-in settings as default when version is 0', async () => {
    const settingsService = mockDeep<ModerationSettingsService>();
    const moderationService = mockDeep<ContentModerationService>();
    settingsService.get.mockResolvedValue(makeSettings({ version: 0 }));

    const controller = new AdminModerationController(
      settingsService,
      moderationService,
    );
    const result = await controller.find();

    expect(result.isDefault).toBe(true);
    expect(result.version).toBe(0);
  });

  it('marks saved settings as non-default when version > 0', async () => {
    const settingsService = mockDeep<ModerationSettingsService>();
    const moderationService = mockDeep<ContentModerationService>();
    settingsService.get.mockResolvedValue(
      makeSettings({
        version: 3,
        updatedById: 'admin-1',
        updatedAt: new Date('2026-11-17T00:00:00Z'),
      }),
    );

    const controller = new AdminModerationController(
      settingsService,
      moderationService,
    );
    const result = await controller.find();

    expect(result.isDefault).toBe(false);
    expect(result.version).toBe(3);
  });

  it('saves policy edits with the admin id and expected version', async () => {
    const settingsService = mockDeep<ModerationSettingsService>();
    const moderationService = mockDeep<ContentModerationService>();
    const saved = makeSettings({ version: 2, updatedById: 'admin-1' });
    settingsService.save.mockResolvedValue(saved);

    const controller = new AdminModerationController(
      settingsService,
      moderationService,
    );
    const dto: UpdateModerationSettingsDto = {
      instructions: saved.instructions,
      allowDescription: saved.allowDescription,
      choices: saved.choices,
      rejectThreshold: 0.85,
      reviewThreshold: 0.3,
      version: 1,
    };

    const result = await controller.update(adminRequest, dto);

    expect(settingsService.save).toHaveBeenCalledWith(
      {
        instructions: dto.instructions,
        allowDescription: dto.allowDescription,
        choices: dto.choices,
        rejectThreshold: 0.85,
        reviewThreshold: 0.3,
      },
      'admin-1',
      1,
    );
    expect(result).toEqual({ ...saved, isDefault: false });
  });

  it('propagates version conflicts on update', async () => {
    const settingsService = mockDeep<ModerationSettingsService>();
    const moderationService = mockDeep<ContentModerationService>();
    settingsService.save.mockRejectedValue(
      new StateConflictException('CONFLICT', 'Stale version'),
    );

    const controller = new AdminModerationController(
      settingsService,
      moderationService,
    );
    const dto: UpdateModerationSettingsDto = {
      instructions: 'Classify content safely for plant-based cooking.',
      allowDescription: 'Everyday cooking posts and friendly questions.',
      choices: [
        {
          key: 'hate',
          label: 'Thù ghét',
          reasonText: 'ngôn từ thù ghét',
          description: 'Attacks or dehumanises people or groups.',
        },
      ],
      rejectThreshold: 0.85,
      reviewThreshold: 0.3,
      version: 0,
    };

    await expect(controller.update(adminRequest, dto)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('resets settings back to defaults', async () => {
    const settingsService = mockDeep<ModerationSettingsService>();
    const moderationService = mockDeep<ContentModerationService>();
    const defaults = makeSettings({ version: 0 });
    settingsService.reset.mockResolvedValue(defaults);

    const controller = new AdminModerationController(
      settingsService,
      moderationService,
    );
    const result = await controller.reset();

    expect(settingsService.reset).toHaveBeenCalledOnce();
    expect(result).toEqual({ ...defaults, isDefault: true });
  });

  it('tests text against saved or draft policy without storing anything', async () => {
    const settingsService = mockDeep<ModerationSettingsService>();
    const moderationService = mockDeep<ContentModerationService>();
    const assessment = {
      decision: 'review' as const,
      category: 'hate',
      violationScore: 0.55,
      scores: { allow: 0.45, hate: 0.55 },
    };
    moderationService.review.mockResolvedValue(assessment);

    const controller = new AdminModerationController(
      settingsService,
      moderationService,
    );
    const draftSettings = {
      instructions: 'Classify content safely for plant-based cooking.',
      allowDescription: 'Everyday cooking posts and friendly questions.',
      choices: [
        {
          key: 'hate',
          label: 'Thù ghét',
          reasonText: 'ngôn từ thù ghét',
          description: 'Attacks or dehumanises people or groups.',
        },
      ],
      rejectThreshold: 0.85,
      reviewThreshold: 0.3,
    };
    const dto: TestModerationDto = {
      text: 'sample post',
      settings: draftSettings,
    };

    const result = await controller.test(dto);

    expect(moderationService.review).toHaveBeenCalledWith(
      [{ kind: 'text', text: 'sample post' }],
      undefined,
      draftSettings,
    );
    expect(result).toEqual(assessment);
  });

  it('turns model failures during test into 503 SERVICE_UNAVAILABLE', async () => {
    const settingsService = mockDeep<ModerationSettingsService>();
    const moderationService = mockDeep<ContentModerationService>();
    moderationService.review.mockRejectedValue(new Error('timeout'));

    const controller = new AdminModerationController(
      settingsService,
      moderationService,
    );

    await expect(controller.test({ text: 'hello' })).rejects.toThrow(
      FeatureUnavailableException,
    );
    expect(vi.isMockFunction(moderationService.review)).toBe(true);
  });
});
