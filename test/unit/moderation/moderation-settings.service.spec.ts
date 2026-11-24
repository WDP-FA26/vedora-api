import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import { ModerationSettingsService } from '../../../src/moderation/moderation-settings.service.js';
import type { ContentPolicySettings } from '../../../src/moderation/policies/content.js';

describe('ModerationSettingsService', () => {
  let app: INestApplication;
  let service: ModerationSettingsService;

  const draft = (): ContentPolicySettings => {
    const { choices, instructions, allowDescription } = service.defaults();
    return { instructions: `${instructions} Be strict.`, allowDescription, choices };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('modsettings'))],
      providers: [ModerationSettingsService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    service = app.get(ModerationSettingsService);
  });
  beforeEach(async () => {
    // A reset keeps the row and its version count; start from no row at all.
    await app
      .get(MongoService)
      .connection.collection('moderation_settings')
      .deleteMany({});
    await service.reset();
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('serves the built-in policy until someone saves', async () => {
    const settings = await service.get();
    expect(settings).toMatchObject({ version: 0, updatedById: null });
    expect(settings.choices.map(({ key }) => key)).toContain('violence');
  });

  it('saves an edit, counts versions and applies it at once', async () => {
    const edited = draft();
    edited.choices.push({
      key: 'politics',
      label: 'Chính trị',
      reasonText: 'nội dung chính trị',
      description: 'Campaigning or partisan political messaging.',
    });

    const first = await service.save(edited, 'admin-1', 0);
    expect(first).toMatchObject({ version: 1, updatedById: 'admin-1' });
    const second = await service.save(first, 'admin-2', 1);
    expect(second.version).toBe(2);

    const current = await service.get();
    expect(current.choices.at(-1)?.key).toBe('politics');
    expect(current.instructions).toMatch(/Be strict\.$/);
    expect((await service.reasonTexts()).get('politics')).toBe(
      'nội dung chính trị',
    );
  });

  it('refuses a save based on an old version', async () => {
    await service.save(draft(), 'admin-1', 0);
    await expect(service.save(draft(), 'admin-2', 0)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await service.save(draft(), 'admin-1', 1);
    await expect(service.save(draft(), 'admin-2', 1)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('goes back to the defaults on reset', async () => {
    await service.save(draft(), 'admin-1', 0);
    expect((await service.reset()).version).toBe(0);
    expect((await service.get()).instructions).not.toMatch(/Be strict\.$/);
  });
});
