import { mockDeep } from 'vitest-mock-extended';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ProfilesService } from '../profiles/profiles.service';
import { StorageWebhookController } from './storage-webhook.controller';
import { StorageService, StorageTarget } from './storage.service';

describe('StorageWebhookController', () => {
  const storage = mockDeep<StorageService>();
  const knowledge = mockDeep<KnowledgeService>();
  const profiles = mockDeep<ProfilesService>();
  const controller = new StorageWebhookController(storage, knowledge, profiles);
  const body = { Records: [] };

  beforeEach(() => vi.clearAllMocks());

  it('starts ingestion for each stored knowledge object', async () => {
    storage.parseEvent.mockReturnValue(['knowledge/a.pdf', 'knowledge/b.pdf']);
    await controller.receive(StorageTarget.Knowledge, body);
    expect(storage.parseEvent).toHaveBeenCalledWith(
      StorageTarget.Knowledge,
      body,
    );
    expect(knowledge.markUploaded.mock.calls).toEqual([
      ['knowledge/a.pdf'],
      ['knowledge/b.pdf'],
    ]);
    expect(profiles.markImageUploaded).not.toHaveBeenCalled();
  });

  it('marks each stored profile image ready', async () => {
    const key = 'profiles/u/avatar/a.webp';
    storage.parseEvent.mockReturnValue([key]);
    await controller.receive(StorageTarget.Profiles, body);
    expect(profiles.markImageUploaded).toHaveBeenCalledWith(key);
    expect(knowledge.markUploaded).not.toHaveBeenCalled();
  });
});
