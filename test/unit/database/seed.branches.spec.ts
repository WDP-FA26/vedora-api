import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { compare } from 'bcryptjs';
import { createUser } from '@test/support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '@test/support/mongo-test-db.js';
import { MongoModule } from '@src/mongo/mongo.module.js';
import { MongoService } from '@src/mongo/mongo.service.js';
import { type User, UserRole } from '@src/mongo/models.js';
import { seedDatabase } from '@src/database/seed.js';

describe('seedDatabase edge branches', () => {
  let app: INestApplication;
  let mongo: MongoService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('seed-branches'))],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
  });

  beforeEach(async () => {
    await mongo.connection.model<User>('User').deleteMany({});
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('skips when SEED_USER_PASSWORD is unset and rejects >72 UTF-8 byte passwords', async () => {
    vi.stubEnv('SEED_USER_PASSWORD', '');
    await seedDatabase(mongo);
    expect(await mongo.connection.model<User>('User').countDocuments()).toBe(0);

    vi.stubEnv('SEED_USER_PASSWORD', 'a'.repeat(73));
    await expect(seedDatabase(mongo)).rejects.toThrow(
      'must not exceed 72 UTF-8 bytes',
    );
  });

  it('replaces placeholder !migrated-user-has-no-password on existing admin', async () => {
    vi.stubEnv('SEED_USER_PASSWORD', 'StrongPassword123!');
    await createUser(mongo, {
      username: 'vedora.admin',
      fullName: 'Old Name',
      email: 'admin@vedora.local',
      role: UserRole.ADMIN,
      passwordHash: '!migrated-user-has-no-password',
      emailVerifiedAt: new Date(),
    });

    await seedDatabase(mongo);
    const admin = await mongo.connection
      .model<User>('User')
      .findOne({ email: 'admin@vedora.local' })
      .exec();
    expect(admin?.fullName).toBe('Vedora Admin');
    expect(await compare('StrongPassword123!', admin?.passwordHash ?? '')).toBe(
      true,
    );
  });
});
