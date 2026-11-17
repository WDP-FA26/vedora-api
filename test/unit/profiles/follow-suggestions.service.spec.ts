import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import {
  Follow,
  FollowSuggestion,
  FollowSuggestionReason,
  Post,
  PostStatus,
  SuggestionDismissal,
  User,
} from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import { FollowSuggestionsService } from '../../../src/profiles/follow-suggestions.service.js';
import { createPost, createUser } from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

describe('FollowSuggestionsService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: FollowSuggestionsService;

  const users = () => db.connection.model<User>(User.name);
  const follows = () => db.connection.model<Follow>(Follow.name);
  const posts = () => db.connection.model<Post>(Post.name);
  const suggestions = () =>
    db.connection.model<FollowSuggestion>(FollowSuggestion.name);
  const dismissals = () =>
    db.connection.model<SuggestionDismissal>(SuggestionDismissal.name);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('followsuggestions'))],
      providers: [FollowSuggestionsService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(FollowSuggestionsService);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await users().deleteMany({});
    await follows().deleteMany({});
    await posts().deleteMany({});
    await suggestions().deleteMany({});
    await dismissals().deleteMany({});
    // Clear internal 10-minute activeAuthors cache by mocking time past expiry if needed;
    // since each test resets posts/users, advancing Date.now guarantees a fresh pool.
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  describe('rebuild and list ranking', () => {
    it('ranks FOLLOWS_YOU above MUTUAL, counts mutuals, and excludes self/unverified/followed/dismissed', async () => {
      const viewer = await createUser(db, { username: 'viewer' });
      const friend1 = await createUser(db, { username: 'friend1' });
      const friend2 = await createUser(db, { username: 'friend2' });
      const mutualTwo = await createUser(db, { username: 'mutual.two' });
      const mutualOne = await createUser(db, { username: 'mutual.one' });
      const followsViewer = await createUser(db, { username: 'fan' });
      const bothSignals = await createUser(db, { username: 'fan.mutual' });
      const unverified = await createUser(db, {
        username: 'unverified',
        emailVerifiedAt: null,
      });
      const dismissedFan = await createUser(db, { username: 'dismissed' });

      await follows().create([
        // viewer follows friend1 and friend2
        { followerId: viewer.id, followingId: friend1.id },
        { followerId: viewer.id, followingId: friend2.id },
        // friend1 & friend2 follow mutualTwo -> mutualCount = 2
        { followerId: friend1.id, followingId: mutualTwo.id },
        { followerId: friend2.id, followingId: mutualTwo.id },
        // friend1 follows mutualOne, viewer itself, unverified, and bothSignals
        { followerId: friend1.id, followingId: mutualOne.id },
        { followerId: friend1.id, followingId: viewer.id },
        { followerId: friend1.id, followingId: unverified.id },
        { followerId: friend1.id, followingId: bothSignals.id },
        // followsViewer, bothSignals, dismissedFan, and unverified follow viewer
        { followerId: followsViewer.id, followingId: viewer.id },
        { followerId: bothSignals.id, followingId: viewer.id },
        { followerId: dismissedFan.id, followingId: viewer.id },
        { followerId: unverified.id, followingId: viewer.id },
      ]);
      await service.dismiss(viewer.id, dismissedFan.id);

      await service.rebuild([viewer.id]);

      const stored = await suggestions()
        .find({ userId: viewer.id })
        .sort({ score: -1, candidateId: 1 })
        .exec();
      expect(
        stored.map((s) => ({
          candidateId: s.candidateId,
          reason: s.reason,
          mutualCount: s.mutualCount,
          score: s.score,
        })),
      ).toEqual([
        {
          candidateId: bothSignals.id,
          reason: FollowSuggestionReason.FOLLOWS_YOU,
          mutualCount: 1,
          score: 1001,
        },
        {
          candidateId: followsViewer.id,
          reason: FollowSuggestionReason.FOLLOWS_YOU,
          mutualCount: 0,
          score: 1000,
        },
        {
          candidateId: mutualTwo.id,
          reason: FollowSuggestionReason.MUTUAL,
          mutualCount: 2,
          score: 2,
        },
        {
          candidateId: mutualOne.id,
          reason: FollowSuggestionReason.MUTUAL,
          mutualCount: 1,
          score: 1,
        },
      ]);

      const topThree = await service.list(viewer.id, 3);
      expect(topThree.items).toHaveLength(3);
      expect(topThree.items.map((item) => item.id)).toEqual([
        bothSignals.id,
        followsViewer.id,
        mutualTwo.id,
      ]);
      expect(topThree.items[0]).not.toHaveProperty('email');
    });

    it('filters out newly followed, unverified, or dismissed candidates at read time before rebuild runs', async () => {
      const viewer = await createUser(db);
      const fan1 = await createUser(db);
      const fan2 = await createUser(db);
      const fan3 = await createUser(db);

      await follows().create([
        { followerId: fan1.id, followingId: viewer.id },
        { followerId: fan2.id, followingId: viewer.id },
        { followerId: fan3.id, followingId: viewer.id },
      ]);
      await service.rebuild([viewer.id]);

      // Mutate state after rebuild: follow fan1, unverify fan2, delete fan3
      await follows().create({ followerId: viewer.id, followingId: fan1.id });
      await users().updateOne(
        { _id: fan2.id },
        { $set: { emailVerifiedAt: null } },
      );
      await users().deleteOne({ _id: fan3.id });

      const result = await service.list(viewer.id, 5);
      expect(result.items).toEqual([]);
    });

    it('clears stale suggestion rows when a user no longer has graph signals', async () => {
      const viewer = await createUser(db);
      const fan = await createUser(db);
      await follows().create({ followerId: fan.id, followingId: viewer.id });
      await service.rebuild([viewer.id]);
      expect(await suggestions().countDocuments({ userId: viewer.id })).toBe(1);

      await follows().deleteMany({});
      await service.rebuild([viewer.id]);
      expect(await suggestions().countDocuments({ userId: viewer.id })).toBe(0);
    });
  });

  describe('ACTIVE fallback and cache', () => {
    it('backfills up to limit with recent published verified authors and caches the active pool', async () => {
      const realNow = Date.now.bind(Date);
      let offset = 20 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
      const now = realNow() + offset;

      const viewer = await createUser(db);
      const activeTop = await createUser(db, { username: 'active.top' });
      const activeSecond = await createUser(db, { username: 'active.second' });
      const followedActive = await createUser(db, {
        username: 'active.followed',
      });
      const unverifiedActive = await createUser(db, {
        username: 'active.unverified',
        emailVerifiedAt: null,
      });

      await follows().create({
        followerId: viewer.id,
        followingId: followedActive.id,
      });

      const recent = new Date(now - 2 * 24 * 60 * 60 * 1000);
      const stale = new Date(now - 45 * 24 * 60 * 60 * 1000);
      await createPost(db, { authorId: activeTop.id, publishedAt: recent });
      await createPost(db, { authorId: activeTop.id, publishedAt: recent });
      await createPost(db, { authorId: activeSecond.id, publishedAt: recent });
      await createPost(db, {
        authorId: followedActive.id,
        publishedAt: recent,
      });
      await createPost(db, {
        authorId: unverifiedActive.id,
        publishedAt: recent,
      });
      // Ignored: DRAFT and >30d old
      await createPost(db, {
        authorId: viewer.id,
        publishedAt: recent,
      });
      await createPost(db, {
        authorId: activeSecond.id,
        status: PostStatus.DRAFT,
        publishedAt: recent,
      });
      await createPost(db, {
        authorId: activeSecond.id,
        publishedAt: stale,
      });

      const aggregateSpy = vi.spyOn(posts(), 'aggregate');

      const first = await service.list(viewer.id, 5);
      expect(first.items).toEqual([
        expect.objectContaining({
          id: activeTop.id,
          reason: 'ACTIVE',
          mutualCount: 0,
        }),
        expect.objectContaining({
          id: activeSecond.id,
          reason: 'ACTIVE',
          mutualCount: 0,
        }),
      ]);
      expect(aggregateSpy).toHaveBeenCalledTimes(1);

      // Within 10-minute TTL, activePool uses cache
      offset += 5 * 60 * 1000;
      const second = await service.list(viewer.id, 5);
      expect(second.items).toHaveLength(2);
      expect(aggregateSpy).toHaveBeenCalledTimes(1);

      // Past 10-minute TTL, activePool recomputes
      offset += 6 * 60 * 1000;
      await service.list(viewer.id, 5);
      expect(aggregateSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('dismiss', () => {
    it('persists dismissal idempotently and removes any matching suggestion', async () => {
      const viewer = await createUser(db);
      const candidate = await createUser(db);
      await suggestions().create({
        userId: viewer.id,
        candidateId: candidate.id,
        score: 1000,
        reason: FollowSuggestionReason.FOLLOWS_YOU,
        mutualCount: 0,
      });

      await service.dismiss(viewer.id, candidate.id);
      await service.dismiss(viewer.id, candidate.id);

      expect(
        await dismissals().countDocuments({
          userId: viewer.id,
          candidateId: candidate.id,
        }),
      ).toBe(1);
      expect(
        await suggestions().countDocuments({
          userId: viewer.id,
          candidateId: candidate.id,
        }),
      ).toBe(0);
    });

    it('rethrows non-unique database errors during dismiss', async () => {
      vi.spyOn(dismissals(), 'create').mockRejectedValueOnce(
        new Error('connection lost'),
      );

      await expect(
        service.dismiss(randomUUID(), randomUUID()),
      ).rejects.toThrow('connection lost');
    });
  });

  describe('rebuildAll', () => {
    it('rebuilds verified users only and continues if a batch fails', async () => {
      const verified = await createUser(db);
      const unverified = await createUser(db, { emailVerifiedAt: null });
      await follows().create({
        followerId: verified.id,
        followingId: unverified.id,
      });
      const fan = await createUser(db);
      await follows().create({
        followerId: fan.id,
        followingId: verified.id,
      });

      await service.rebuildAll();
      expect(
        await suggestions().countDocuments({ userId: verified.id }),
      ).toBe(1);
      expect(
        await suggestions().countDocuments({ userId: unverified.id }),
      ).toBe(0);

      const rebuildSpy = vi
        .spyOn(service, 'rebuild')
        .mockRejectedValueOnce(new Error('transient error'));
      await expect(service.rebuildAll()).resolves.toBeUndefined();
      expect(rebuildSpy).toHaveBeenCalledOnce();
    });
  });
});
