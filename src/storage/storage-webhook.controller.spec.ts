import { mockDeep } from 'vitest-mock-extended';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { StorageWebhookController } from './storage-webhook.controller';
import { StorageService, StorageTarget } from './storage.service';

describe('StorageWebhookController', () => {
  const storage = mockDeep<StorageService>();
  const knowledge = mockDeep<KnowledgeService>();
  const controller = new StorageWebhookController(storage, knowledge);
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
  });
});
