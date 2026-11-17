import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AdminModerationController } from '../../../src/moderation/admin-moderation.controller.js';
import {
  CONTENT_MODERATION_MODEL,
  ContentModerationService,
} from '../../../src/moderation/content-moderation.service.js';
import { ModerationSettingsService } from '../../../src/moderation/moderation-settings.service.js';
import { ModerationModule } from '../../../src/moderation/moderation.module.js';
import {
  AiCostCall,
  ModerationSettings,
  User,
} from '../../../src/mongo/models.js';

describe('ModerationModule', () => {
  async function compileWithEnv(env: Record<string, string>) {
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => env],
        }),
        ModerationModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService(env))
      .useMocker((token) => {
        if (token === getModelToken(AiCostCall.name)) return {};
        if (token === getModelToken(ModerationSettings.name)) return {};
        if (token === getModelToken(User.name)) return {};
        if (token === JwtService) return {};
        return undefined;
      })
      .compile();
  }

  it('wires controller, services, and evaluation model from config', async () => {
    const moduleRef = await compileWithEnv({
      OPENROUTER_API_KEY: 'test-openrouter-key',
      OPENROUTER_CONTENT_MODERATION_MODEL: 'google/gemini-decision-1',
    });

    expect(moduleRef.get(AdminModerationController)).toBeInstanceOf(
      AdminModerationController,
    );
    expect(moduleRef.get(ContentModerationService)).toBeInstanceOf(
      ContentModerationService,
    );
    expect(moduleRef.get(ModerationSettingsService)).toBeInstanceOf(
      ModerationSettingsService,
    );
    const model = moduleRef.get<{ modelId: string }>(CONTENT_MODERATION_MODEL);
    expect(model.modelId).toBe('google/gemini-decision-1');
  });

  it('fails fast when OPENROUTER_API_KEY is missing', async () => {
    await expect(compileWithEnv({})).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});
