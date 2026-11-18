import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { AccountStatus, User } from '../../../../src/mongo/models.js';
import { MongoModule } from '../../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../../src/mongo/mongo.service.js';
import {
  profileBm25,
  profilePrefixBm25,
} from '../../../../src/profiles/search/profile-search-collection.js';
import { ProfileSearchIndexService } from '../../../../src/profiles/search/profile-search-index.service.js';
import { QdrantService } from '../../../../src/qdrant/qdrant.service.js';
import { createUser } from '../../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../../support/mongo-test-db.js';

describe('ProfileSearchIndexService', () => {
  let app: INestApplication;
  let db: MongoService;
  let users: Model<User>;
  let qdrant: DeepMockProxy<QdrantService>;
  let service: ProfileSearchIndexService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('profilesearchindex'))],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    users = app.get(getModelToken(User.name));
  });

  beforeEach(async () => {
    await db.connection.collections.users.deleteMany({});
    qdrant = mockDeep<QdrantService>();
    qdrant.collectionExists.mockResolvedValue({ exists: true });
    qdrant.getCollection.mockResolvedValue({
      config: {
        params: {
          sparse_vectors: {
            identity_bm25: {},
            identity_bm25_folded: {},
            identity_prefix: {},
            bio_bm25: {},
            bio_bm25_folded: {},
          },
        },
      },
    } as never);
    service = new ProfileSearchIndexService(
      qdrant,
      new ConfigService({ QDRANT_PROFILES_COLLECTION: 'test_profiles' }),
      users,
    );
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('indexes only active verified users into Qdrant BM25 sparse vectors', async () => {
    const active = await createUser(db, {
      username: 'minh.anh',
      fullName: 'Minh Anh',
      bio: 'Nấu món chay mỗi ngày',
      emailVerifiedAt: new Date(),
      status: AccountStatus.ACTIVE,
    });
    const pending = await createUser(db, {
      username: 'pending.user',
      fullName: 'Pending User',
      emailVerifiedAt: null,
      status: AccountStatus.PENDING_EMAIL,
    });
    const suspended = await createUser(db, {
      username: 'suspended.user',
      fullName: 'Suspended User',
      emailVerifiedAt: new Date(),
      status: AccountStatus.SUSPENDED,
    });

    await service.drain();

    const identity = 'Minh Anh\nminh.anh\nminh anh';
    expect(qdrant.upsert).toHaveBeenCalledWith('test_profiles', {
      wait: true,
      points: [
        {
          id: active.id,
          vector: {
            identity_bm25: profileBm25(identity, false),
            identity_bm25_folded: profileBm25(identity, true),
            identity_prefix: profilePrefixBm25(identity),
            bio_bm25: profileBm25('Nấu món chay mỗi ngày', false),
            bio_bm25_folded: profileBm25('Nấu món chay mỗi ngày', true),
          },
          payload: { userId: active.id },
        },
      ],
    });
    expect(
      (await users.findById(active.id).exec())?.searchIndexedAt,
    ).toBeInstanceOf(Date);
    expect(
      (await users.findById(pending.id).exec())?.searchIndexedAt,
    ).toBeNull();
    expect(
      (await users.findById(suspended.id).exec())?.searchIndexedAt,
    ).toBeNull();
  });

  it('creates a sparse-only BM25 collection when missing and resets indexed markers', async () => {
    const indexed = await createUser(db, {
      emailVerifiedAt: new Date(),
      status: AccountStatus.ACTIVE,
      searchIndexedAt: new Date(),
    });
    qdrant.collectionExists.mockResolvedValue({ exists: false });

    await service.ensureCollection();

    expect(qdrant.createCollection).toHaveBeenCalledWith('test_profiles', {
      sparse_vectors: {
        identity_bm25: { modifier: 'idf' },
        identity_bm25_folded: { modifier: 'idf' },
        identity_prefix: { modifier: 'idf' },
        bio_bm25: { modifier: 'idf' },
        bio_bm25_folded: { modifier: 'idf' },
      },
    });
    expect(
      (await users.findById(indexed.id).exec())?.searchIndexedAt,
    ).toBeNull();
  });

  it('deletes a removed profile from Qdrant', async () => {
    await service.remove('u1');

    expect(qdrant.delete).toHaveBeenCalledWith('test_profiles', {
      wait: true,
      points: ['u1'],
    });
  });
});
