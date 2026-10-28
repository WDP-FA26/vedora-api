import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db';
import { MongoModule } from '../mongo/mongo.module';
import { MongoService } from '../mongo/mongo.service';
import {
  type KnowledgeDocument,
  KnowledgeDocumentFailureReason,
  KnowledgeDocumentStatus,
} from '../mongo/models';
import { KnowledgeMaintenanceService } from './knowledge-maintenance.service';

describe('KnowledgeMaintenanceService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: KnowledgeMaintenanceService;
  const now = new Date('2026-09-28T12:00:00Z');
  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000);

  const documents = () =>
    db.connection.model<KnowledgeDocument>('KnowledgeDocument');
  /** A row in `status`, last touched `updatedAt`; created with it too. */
  const add = (status: KnowledgeDocumentStatus, updatedAt: Date) => {
    const id = crypto.randomUUID();
    return documents().create({
      _id: id,
      title: 'dinh-duong.pdf',
      contentType: 'application/pdf',
      storageKey: `knowledge/${id}.pdf`,
      status,
      createdAt: updatedAt,
      updatedAt,
    });
  };
  const reload = (id: string) => documents().findById(id).exec();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('knowledge'))],
      providers: [KnowledgeMaintenanceService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(KnowledgeMaintenanceService);
  });
  beforeEach(async () => {
    vi.useFakeTimers({ now, toFake: ['Date'] });
    await db.db.collection('knowledge_documents').deleteMany({});
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('fails uploads whose callback never came, after token expiry and grace', async () => {
    const stale = await add(
      KnowledgeDocumentStatus.WAITING_UPLOAD,
      minutesAgo(71),
    );
    const fresh = await add(
      KnowledgeDocumentStatus.WAITING_UPLOAD,
      minutesAgo(69),
    );

    await service.failIncomplete();

    expect(await reload(stale.id)).toMatchObject({
      status: KnowledgeDocumentStatus.FAILED,
      failureReason: KnowledgeDocumentFailureReason.UPLOAD_EXPIRED,
    });
    expect((await reload(fresh.id))?.status).toBe(
      KnowledgeDocumentStatus.WAITING_UPLOAD,
    );
  });

  it('fails extractions interrupted for over 15 minutes', async () => {
    const stuck = await add(KnowledgeDocumentStatus.PROCESSING, minutesAgo(16));
    const running = await add(
      KnowledgeDocumentStatus.PROCESSING,
      minutesAgo(14),
    );

    await service.failIncomplete();

    expect(await reload(stuck.id)).toMatchObject({
      status: KnowledgeDocumentStatus.FAILED,
      failureReason: KnowledgeDocumentFailureReason.EXTRACTION_FAILED,
    });
    expect((await reload(running.id))?.status).toBe(
      KnowledgeDocumentStatus.PROCESSING,
    );
  });
});
