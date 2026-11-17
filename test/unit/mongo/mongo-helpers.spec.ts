import { mongo, type ClientSession, type Connection, type Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { FeatureUnavailableException } from '../../../src/common/exceptions/feature-unavailable.exception.js';
import { StateConflictException } from '../../../src/common/exceptions/state-conflict.exception.js';
import {
  DocumentLock,
  lockDocument,
} from '../../../src/mongo/document-lock.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import { allExist } from '../../../src/mongo/references.js';
import {
  _everyModelNameIsRegistered,
  MODEL_DEFINITIONS,
  registerModels,
} from '../../../src/mongo/schemas/model-definitions.js';
import { MODEL_NAMES } from '../../../src/mongo/schemas/model-names.js';
import { withUserLocks } from '../../../src/mongo/with-user-locks.js';

describe('mongo helpers & module', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('registers all model names and schemas idempotently', () => {
    expect(_everyModelNameIsRegistered).toBe(true);
    expect(MODEL_NAMES.length).toBe(MODEL_DEFINITIONS.length);

    const registered: Record<string, unknown> = { User: {} };
    const model = vi.fn((name: string, schema: unknown) => {
      registered[name] = schema;
      return schema;
    });
    const fakeConnection = { models: registered, model } as unknown as Connection;
    registerModels(fakeConnection);

    expect(model).toHaveBeenCalledTimes(MODEL_DEFINITIONS.length - 1);
  });

  it('MongoModule.forRoot builds global module and requires DATABASE_URL in factory', async () => {
    const dyn = MongoModule.forRoot();
    expect(dyn.global).toBe(true);
    expect(dyn.exports).toContain(MongoService);

    const { Test } = await import('@nestjs/testing');
    vi.stubEnv('DATABASE_URL', '');
    await expect(
      Test.createTestingModule({ imports: [MongoModule.forRoot()] }).compile(),
    ).rejects.toThrow('DATABASE_URL is not set');

    const { createTestMongoUrl, dropTestDatabase } = await import(
      '../../support/mongo-test-db.js'
    );
    vi.stubEnv('DATABASE_URL', createTestMongoUrl('mongo_root'));
    const mod = await Test.createTestingModule({
      imports: [MongoModule.forRoot()],
    }).compile();
    const app = mod.createNestApplication();
    await app.init();
    await dropTestDatabase(app);
    await app.close();
  });

  it('MongoService.ping throws when db is absent and pings when ready', async () => {
    const unready = new MongoService({ db: undefined } as unknown as Connection);
    await expect(unready.ping()).rejects.toBeInstanceOf(
      FeatureUnavailableException,
    );

    const command = vi.fn().mockResolvedValue({ ok: 1 });
    const ready = new MongoService({
      db: { admin: () => ({ command }) },
    } as unknown as Connection);
    await expect(ready.ping()).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledWith({ ping: 1 });
  });

  it('lockDocument uses existing or newly registered DocumentLock model', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const updateOne = vi.fn((_filter: { _id: string }) => ({ exec }));
    const connWithExisting = {
      models: { [DocumentLock.name]: { updateOne } },
      model: vi.fn(),
    } as unknown as Connection;

    const session = {} as ClientSession;
    await lockDocument(
      { connection: connWithExisting },
      session,
      'account-gate',
    );
    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'account-gate' },
      { $inc: { version: 1 } },
      { upsert: true, session },
    );

    const connWithoutExisting = {
      models: {},
      model: vi.fn(() => ({ updateOne })),
    } as unknown as Connection;
    await lockDocument(
      { connection: connWithoutExisting },
      session,
      'user',
      'u1',
    );
    expect(updateOne).toHaveBeenLastCalledWith(
      { _id: 'user:u1' },
      { $inc: { version: 1 } },
      { upsert: true, session },
    );
  });

  it('allExist short-circuits empty input and checks unique IDs', async () => {
    const countDocuments = vi.fn();
    const model = { countDocuments } as unknown as Model<unknown>;

    await expect(allExist(model, [])).resolves.toBe(true);
    expect(countDocuments).not.toHaveBeenCalled();

    countDocuments.mockResolvedValueOnce(2);
    await expect(allExist(model, ['a', 'b', 'a'])).resolves.toBe(true);

    countDocuments.mockResolvedValueOnce(1);
    await expect(allExist(model, ['a', 'b'])).resolves.toBe(false);
  });

  it('withUserLocks sorts unique IDs, retries on E11000, rethrows non-unique errors, and stops after 5 conflicts', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const updateOne = vi.fn((_filter: { _id: string }) => ({ exec }));
    const fakeMongo = {
      connection: {
        models: { [DocumentLock.name]: { updateOne } },
      },
      withTransaction: vi.fn(
        async (fn: (session: ClientSession) => Promise<unknown>) =>
          fn({} as ClientSession),
      ),
    } as unknown as MongoService;

    const idA = randomUUID();
    const idB = randomUUID();
    const [first, second] = [idA, idB].sort();
    const result = await withUserLocks(fakeMongo, [idB, idA, idB], () =>
      Promise.resolve('done'),
    );
    expect(result).toBe('done');
    expect(updateOne.mock.calls.map((c) => c[0]._id)).toEqual([
      `user:${first}`,
      `user:${second}`,
    ]);

    const dupError = new mongo.MongoServerError({ message: 'dup', code: 11000 });
    vi.mocked(fakeMongo.withTransaction)
      .mockRejectedValueOnce(dupError)
      .mockResolvedValueOnce('recovered');
    await expect(
      withUserLocks(fakeMongo, [idA], () => Promise.resolve('recovered')),
    ).resolves.toBe('recovered');

    vi.mocked(fakeMongo.withTransaction).mockRejectedValueOnce(
      new Error('fatal'),
    );
    await expect(
      withUserLocks(fakeMongo, [idA], () => Promise.resolve('nope')),
    ).rejects.toThrow('fatal');

    vi.mocked(fakeMongo.withTransaction).mockRejectedValue(dupError);
    await expect(
      withUserLocks(fakeMongo, [idA], () => Promise.resolve('nope')),
    ).rejects.toBeInstanceOf(StateConflictException);
  });
});
