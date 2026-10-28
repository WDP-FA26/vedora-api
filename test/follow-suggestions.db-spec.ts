import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { FollowSuggestionsService } from '../src/profiles/follow-suggestions.service';
import { MongoModule } from '../src/mongo/mongo.module';
import { MongoService } from '../src/mongo/mongo.service';
import { createUser } from './fixtures';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from './mongo-test-db';

type StoredDoc = { _id: string; [key: string]: unknown };

describe('Follow suggestions with MongoDB', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: FollowSuggestionsService;
  const ids: Record<string, string> = {};

  const follows = () => db.db.collection<StoredDoc>('follows');
  const follow = (from: string, to: string) =>
    follows().insertOne({
      _id: randomUUID(),
      followerId: ids[from],
      followingId: ids[to],
      createdAt: new Date(),
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('suggest'))],
      providers: [FollowSuggestionsService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(FollowSuggestionsService);

    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'loner', 'unverified']) {
      const user = await createUser(db, {
        username: `suggest.${name}`,
        fullName: name,
        email: `suggest.${name}@example.test`,
        emailVerifiedAt: name === 'unverified' ? null : new Date(),
      });
      ids[name] = user.id;
    }
    // a follows b and c; they follow d (twice), f and an unverified account;
    // e follows a.
    await follow('a', 'b');
    await follow('a', 'c');
    await follow('b', 'd');
    await follow('c', 'd');
    await follow('c', 'f');
    await follow('b', 'unverified');
    await follow('e', 'a');
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('ranks follow-backs first, then by mutual followings, skipping known and unverified users', async () => {
    await service.rebuild(Object.values(ids));

    const { items } = await service.list(ids.a, 10);
    expect(items.map((i) => [i.id, i.reason, i.mutualCount])).toEqual([
      [ids.e, 'FOLLOWS_YOU', 0],
      [ids.d, 'MUTUAL', 2],
      [ids.f, 'MUTUAL', 1],
    ]);
  });

  it('drops people followed since the last rebuild', async () => {
    await follow('a', 'd');
    const { items } = await service.list(ids.a, 10);
    expect(items.map((i) => i.id)).toEqual([ids.e, ids.f]);
  });

  it('never suggests a dismissed profile again', async () => {
    await service.dismiss(ids.a, ids.f);
    expect((await service.list(ids.a, 10)).items.map((i) => i.id)).toEqual([
      ids.e,
    ]);
    await service.dismiss(ids.a, ids.f);
    expect(
      await db.db
        .collection<StoredDoc>('suggestion_dismissals')
        .countDocuments(),
    ).toBe(1);

    await service.rebuild([ids.a]);
    expect((await service.list(ids.a, 10)).items.map((i) => i.id)).toEqual([
      ids.e,
    ]);
  });

  it('suggests nothing to a user with no graph and no active authors', async () => {
    await service.rebuild([ids.loner]);
    expect((await service.list(ids.loner, 10)).items).toEqual([]);
  });
});
