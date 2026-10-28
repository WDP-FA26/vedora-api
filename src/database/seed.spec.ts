import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from 'bcryptjs';
import { createUser } from '../../test/fixtures';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db';
import { MongoModule } from '../mongo/mongo.module';
import { AccountStatus, type User, UserRole } from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';
import { seedDatabase } from './seed';

describe('Admin bootstrap', () => {
  let app: INestApplication;
  let mongo: MongoService;
  let legacyHash: string;

  const seedAccount = (fields: Partial<User> = {}) =>
    createUser(mongo, {
      username: 'vedora.admin',
      fullName: 'Vedora Admin',
      email: 'admin@vedora.local',
      passwordHash: legacyHash,
      ...fields,
    });
  const seeded = () =>
    mongo.connection
      .model<User>('User')
      .findOne({ email: 'admin@vedora.local' })
      .exec();
  const users = () => mongo.connection.model<User>('User');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('seed'))],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    legacyHash = await hash('StrongPassword123!', 4);
  });
  beforeEach(async () => {
    vi.stubEnv('SEED_USER_PASSWORD', 'StrongPassword123!');
    await users().deleteMany({});
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('creates the bootstrap account with admin access', async () => {
    await seedDatabase(mongo);
    expect(await seeded()).toMatchObject({
      username: 'vedora.admin',
      role: UserRole.ADMIN,
      status: AccountStatus.ACTIVE,
    });
  });

  it('is safe to run again', async () => {
    await seedDatabase(mongo);
    await seedDatabase(mongo);
    expect(await users().countDocuments()).toBe(1);
  });

  it('does not reactivate an existing suspended seed admin', async () => {
    await seedAccount({
      role: UserRole.ADMIN,
      status: AccountStatus.SUSPENDED,
    });
    await seedDatabase(mongo);
    expect((await seeded())?.status).toBe(AccountStatus.SUSPENDED);
  });

  it('promotes the legacy seed account without resetting its password', async () => {
    await seedAccount();
    await seedDatabase(mongo);
    expect(await seeded()).toMatchObject({
      role: UserRole.ADMIN,
      passwordHash: legacyHash,
    });
  });

  it('refuses a verified account that claimed the seed identity with another password', async () => {
    await seedAccount({ passwordHash: await hash('AnotherPassword123!', 4) });
    await expect(seedDatabase(mongo)).rejects.toThrow(
      'refusing to grant admin access',
    );
    expect((await seeded())?.role).toBe(UserRole.USER);
  });

  it.each([{ emailVerifiedAt: null }, { username: 'someone.else' }])(
    'refuses to promote an untrusted account at the seed email: %j',
    async (fields) => {
      await seedAccount(fields);
      await expect(seedDatabase(mongo)).rejects.toThrow(
        'refusing to grant admin access',
      );
      expect((await seeded())?.role).toBe(UserRole.USER);
    },
  );
});
