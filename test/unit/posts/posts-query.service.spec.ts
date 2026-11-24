import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { CloudinaryService } from '../../../src/cloudinary/cloudinary.service.js';
import { ResourceNotFoundException } from '../../../src/common/exceptions/resource-not-found.exception.js';
import { MediaService } from '../../../src/media/media.service.js';
import { ModerationSettingsService } from '../../../src/moderation/moderation-settings.service.js';
import {
  Follow,
  MediaAsset,
  MediaStatus,
  Post,
  PostBookmark,
  PostRepost,
  PostStatus,
  PostType,
  type User,
} from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import { PostRelationsService } from '../../../src/posts/post-relations.service.js';
import { PostsQueryService } from '../../../src/posts/posts-query.service.js';
import {
  MAX_FEED_RESULTS,
  PostFeedService,
} from '../../../src/posts/search/post-feed.service.js';
import {
  MAX_SEARCH_RESULTS,
  PostSearchService,
} from '../../../src/posts/search/post-search.service.js';
import { createMedia, createPost, createUser } from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

describe('PostsQueryService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: PostsQueryService;
  let bookmarksModel: Model<PostBookmark>;
  let repostsModel: Model<PostRepost>;
  let followsModel: Model<Follow>;
  let mediaService: DeepMockProxy<MediaService>;
  let cloudinary: DeepMockProxy<CloudinaryService>;
  let postSearch: DeepMockProxy<PostSearchService>;
  let postFeed: DeepMockProxy<PostFeedService>;
  let moderationSettings: DeepMockProxy<ModerationSettingsService>;
  let author: User;
  let viewer: User;

  beforeAll(async () => {
    mediaService = mockDeep<MediaService>();
    cloudinary = mockDeep<CloudinaryService>();
    postSearch = mockDeep<PostSearchService>();
    postFeed = mockDeep<PostFeedService>();
    moderationSettings = mockDeep<ModerationSettingsService>();

    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('postsquery'))],
      providers: [
        PostsQueryService,
        PostRelationsService,
        { provide: MediaService, useValue: mediaService },
        { provide: CloudinaryService, useValue: cloudinary },
        { provide: PostSearchService, useValue: postSearch },
        { provide: PostFeedService, useValue: postFeed },
        { provide: ModerationSettingsService, useValue: moderationSettings },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(PostsQueryService);
    bookmarksModel = app.get(getModelToken(PostBookmark.name));
    repostsModel = app.get(getModelToken(PostRepost.name));
    followsModel = app.get(getModelToken(Follow.name));
    author = await createUser(db, { username: 'chef.author' });
    viewer = await createUser(db, { username: 'chef.viewer' });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(cloudinary, 'webhooksEnabled', {
      value: true,
      configurable: true,
    });
    moderationSettings.reasonTexts.mockResolvedValue(
      new Map([['spam', 'Nội dung spam']]),
    );
    mediaService.toResponse.mockImplementation((item) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      failureReason: item.failureReason,
      publicId: item.publicId,
      playbackUrl: null,
      posterUrl: null,
      durationSec: item.durationSec,
      aspectRatio: item.aspectRatio,
      captions: [],
    }));
    postSearch.prune.mockResolvedValue();
  });

  afterEach(async () => {
    await Promise.all([
      db.connection.model(Post.name).deleteMany({}),
      db.connection.model(MediaAsset.name).deleteMany({}),
      bookmarksModel.deleteMany({}),
      repostsModel.deleteMany({}),
      followsModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  describe('search', () => {
    it('returns empty page when cursor reaches MAX_SEARCH_RESULTS', async () => {
      const page = await service.search({
        q: 'phở',
        limit: 20,
        cursor: MAX_SEARCH_RESULTS,
      });
      expect(page).toEqual({ items: [], nextCursor: null });
      expect(postSearch.search).not.toHaveBeenCalled();
    });

    it('preserves Qdrant order, prunes missing IDs safely, filters non-published posts, and builds nextCursor', async () => {
      const p1 = await createPost(db, { authorId: author.id, body: 'First' });
      const p2 = await createPost(db, { authorId: author.id, body: 'Second' });
      const draft = await createPost(db, {
        authorId: author.id,
        status: PostStatus.PROCESSING,
        publishedAt: null,
      });
      postSearch.search.mockResolvedValue({
        ids: [p2.id, 'missing-id', draft.id, p1.id],
        hasMore: true,
      });
      postSearch.prune.mockRejectedValueOnce(new Error('qdrant unreachable'));

      const page = await service.search(
        { q: 'đậu hũ', limit: 2, cursor: 0 },
        viewer.id,
      );

      expect(page.items.map((p) => p.id)).toEqual([p2.id, p1.id]);
      expect(page.nextCursor).toBe('2');
      expect(postSearch.prune).toHaveBeenCalledWith(['missing-id']);

      postSearch.search.mockResolvedValue({ ids: [p1.id], hasMore: false });
      const lastPage = await service.search({ q: 'đậu hũ', limit: 10 });
      expect(lastPage.nextCursor).toBeNull();
    });
  });

  describe('feed', () => {
    it('returns empty page when offset reaches MAX_FEED_RESULTS', async () => {
      const page = await service.feed(
        { limit: 10, cursor: `${MAX_FEED_RESULTS}.1700000000000` },
        viewer.id,
      );
      expect(page).toEqual({ items: [], nextCursor: null });
      expect(postFeed.feed).not.toHaveBeenCalled();
    });

    it('hydrates feed items in order and returns encoded nextCursor when more exist', async () => {
      const p1 = await createPost(db, { authorId: author.id, body: 'One' });
      const p2 = await createPost(db, { authorId: author.id, body: 'Two' });
      const p3 = await createPost(db, { authorId: author.id, body: 'Three' });
      postFeed.feed.mockResolvedValue([p2.id, p1.id, p3.id]);

      const page = await service.feed({ limit: 2 }, viewer.id);
      expect(page.items.map((p) => p.id)).toEqual([p2.id, p1.id]);
      expect(page.nextCursor).toMatch(/^2\.\d+$/);

      postFeed.feed.mockResolvedValue([p1.id, p2.id, p3.id]);
      const page2 = await service.feed(
        { limit: 2, cursor: '2.1700000000000' },
        viewer.id,
      );
      expect(page2.items.map((p) => p.id)).toEqual([p3.id]);
      expect(page2.nextCursor).toBeNull();
    });
  });

  describe('list', () => {
    it('filters by authorId/type and paginates by publishedAt DESC cursor', async () => {
      const older = await createPost(db, {
        authorId: author.id,
        type: PostType.POST,
        publishedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const newer = await createPost(db, {
        authorId: author.id,
        type: PostType.POST,
        publishedAt: new Date('2026-01-02T00:00:00Z'),
      });
      await createPost(db, {
        authorId: author.id,
        type: PostType.BLOG,
        publishedAt: new Date('2026-01-03T00:00:00Z'),
      });
      await createPost(db, {
        authorId: viewer.id,
        type: PostType.POST,
        publishedAt: new Date('2026-01-04T00:00:00Z'),
      });

      const page1 = await service.list({
        limit: 1,
        authorId: author.id,
        type: PostType.POST,
      });
      expect(page1.items.map((p) => p.id)).toEqual([newer.id]);
      expect(page1.nextCursor).toBe(newer.id);

      const page2 = await service.list({
        limit: 1,
        authorId: author.id,
        type: PostType.POST,
        cursor: page1.nextCursor ?? undefined,
      });
      expect(page2.items.map((p) => p.id)).toEqual([older.id]);
      expect(page2.nextCursor).toBeNull();

      const invalid = await service.list({ limit: 10, cursor: 'missing-id' });
      expect(invalid).toEqual({ items: [], nextCursor: null });
    });
  });

  describe('listReposts', () => {
    const repost = (postId: string, userId: string, at: string) =>
      repostsModel.create({ postId, userId, createdAt: new Date(at) });

    it('pages published reposts newest-reposted first, skipping unpublished posts without losing the cursor', async () => {
      const first = await createPost(db, { authorId: author.id, body: 'A' });
      const second = await createPost(db, { authorId: author.id, body: 'B' });
      const hidden = await createPost(db, {
        authorId: author.id,
        status: PostStatus.PENDING_REVIEW,
        publishedAt: null,
      });
      await repost(first.id, viewer.id, '2026-01-01T00:00:00Z');
      await repost(hidden.id, viewer.id, '2026-01-02T00:00:00Z');
      await repost(second.id, viewer.id, '2026-01-03T00:00:00Z');
      await repost(first.id, author.id, '2026-01-04T00:00:00Z');

      const page1 = await service.listReposts(viewer.id, { limit: 2 });
      expect(page1.items.map((post) => post.id)).toEqual([second.id]);
      expect(page1.nextCursor).toBe(hidden.id);

      const page2 = await service.listReposts(viewer.id, {
        limit: 2,
        cursor: page1.nextCursor ?? undefined,
      });
      expect(page2.items.map((post) => post.id)).toEqual([first.id]);
      expect(page2.nextCursor).toBeNull();
    });

    it('returns the viewer state, not the reposter state', async () => {
      const post = await createPost(db, { authorId: author.id });
      await repost(post.id, viewer.id, '2026-01-01T00:00:00Z');

      const asGuest = await service.listReposts(viewer.id, { limit: 10 });
      expect(asGuest.items[0]).toMatchObject({
        isReposted: false,
        repostCount: 1,
      });
      const asReposter = await service.listReposts(
        viewer.id,
        { limit: 10 },
        viewer.id,
      );
      expect(asReposter.items[0]).toMatchObject({ isReposted: true });
    });

    it('returns an empty page for a cursor the user never reposted', async () => {
      const post = await createPost(db, { authorId: author.id });
      await repost(post.id, viewer.id, '2026-01-01T00:00:00Z');
      await expect(
        service.listReposts(viewer.id, { limit: 10, cursor: post.id }),
      ).resolves.toEqual({ items: [], nextCursor: null });
      await expect(
        service.listReposts(author.id, { limit: 10, cursor: post.id }),
      ).resolves.toEqual({ items: [], nextCursor: null });
    });

    it('throws NOT_FOUND for an unknown or unverified user', async () => {
      await expect(
        service.listReposts('00000000-0000-4000-8000-000000000000', {
          limit: 10,
        }),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
      const unverified = await createUser(db, {
        username: 'chef.unverified',
        emailVerifiedAt: null,
      });
      await expect(
        service.listReposts(unverified.id, { limit: 10 }),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });
  });

  describe('listBookmarks & listFollowing', () => {
    it('lists published bookmarks newest-saved first and handles invalid cursors', async () => {
      const p1 = await createPost(db, { authorId: author.id, body: 'First' });
      const p2 = await createPost(db, { authorId: author.id, body: 'Second' });
      const draft = await createPost(db, {
        authorId: author.id,
        status: PostStatus.DRAFT,
        publishedAt: null,
      });

      await bookmarksModel.create({
        postId: draft.id,
        userId: viewer.id,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      await bookmarksModel.create({
        postId: p1.id,
        userId: viewer.id,
        createdAt: new Date('2026-01-02T00:00:00Z'),
      });
      await bookmarksModel.create({
        postId: p2.id,
        userId: viewer.id,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      });

      const page1 = await service.listBookmarks(viewer.id, { limit: 1 });
      expect(page1.items.map((p) => p.id)).toEqual([p2.id]);
      expect(page1.nextCursor).toBe(p2.id);

      const page2 = await service.listBookmarks(viewer.id, {
        limit: 10,
        cursor: p2.id,
      });
      expect(page2.items.map((p) => p.id)).toEqual([p1.id]);

      const invalid = await service.listBookmarks(viewer.id, {
        limit: 10,
        cursor: 'missing',
      });
      expect(invalid).toEqual({ items: [], nextCursor: null });
    });

    // Regression for BUG-M7: a non-published post in the lookahead slot
    // must not end pagination early.
    it('keeps paging past an unpublished post in bookmarks', async () => {
      const p1 = await createPost(db, { authorId: author.id, body: 'First' });
      const p2 = await createPost(db, { authorId: author.id, body: 'Second' });
      const draft = await createPost(db, {
        authorId: author.id,
        status: PostStatus.DRAFT,
        publishedAt: null,
      });

      await bookmarksModel.create({
        postId: p1.id,
        userId: viewer.id,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      await bookmarksModel.create({
        postId: draft.id,
        userId: viewer.id,
        createdAt: new Date('2026-01-02T00:00:00Z'),
      });
      await bookmarksModel.create({
        postId: p2.id,
        userId: viewer.id,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      });

      const earlyStop = await service.listBookmarks(viewer.id, { limit: 1 });
      expect(earlyStop.items.map((p) => p.id)).toEqual([p2.id]);
      expect(earlyStop.nextCursor).toBe(p2.id);
    });

    it('lists published short posts from followed authors and handles empty/invalid cursors', async () => {
      const emptyFollows = await service.listFollowing(viewer.id, {
        limit: 10,
      });
      expect(emptyFollows).toEqual({ items: [], nextCursor: null });

      await followsModel.create({
        followerId: viewer.id,
        followingId: author.id,
      });

      const p1 = await createPost(db, {
        authorId: author.id,
        type: PostType.POST,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const p2 = await createPost(db, {
        authorId: author.id,
        type: PostType.POST,
        createdAt: new Date('2026-01-02T00:00:00Z'),
      });
      await createPost(db, {
        authorId: author.id,
        type: PostType.BLOG,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      });

      const page1 = await service.listFollowing(viewer.id, { limit: 1 });
      expect(page1.items.map((p) => p.id)).toEqual([p2.id]);
      expect(page1.nextCursor).toBe(p2.id);

      const page2 = await service.listFollowing(viewer.id, {
        limit: 10,
        cursor: p2.id,
      });
      expect(page2.items.map((p) => p.id)).toEqual([p1.id]);

      const invalid = await service.listFollowing(viewer.id, {
        limit: 10,
        cursor: 'missing',
      });
      expect(invalid).toEqual({ items: [], nextCursor: null });
    });
  });

  describe('findOne, load, & toResponses', () => {
    it('enforces visibility for non-published posts and refreshes media when webhooks are disabled', async () => {
      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
      await expect(service.load('missing')).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );

      const processing = await createPost(db, {
        authorId: author.id,
        status: PostStatus.PROCESSING,
        publishedAt: null,
      });
      await expect(service.findOne(processing.id)).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
      await expect(
        service.findOne(processing.id, viewer.id),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      Object.defineProperty(cloudinary, 'webhooksEnabled', {
        value: false,
        configurable: true,
      });
      const pendingMedia = await createMedia(db, {
        postId: processing.id,
        status: MediaStatus.PROCESSING,
      });
      mediaService.refresh.mockResolvedValue();
      mediaService.settlePosts.mockResolvedValue();

      const asAuthor = await service.findOne(processing.id, author.id);
      expect(asAuthor.id).toBe(processing.id);
      expect(mediaService.refresh).toHaveBeenCalledWith(
        expect.objectContaining({ id: pendingMedia.id }),
      );
      expect(mediaService.settlePosts).toHaveBeenCalledWith([processing.id]);
    });

    it('exposes moderationVerdict and moderationReason only for REJECTED posts', async () => {
      const rejected = await createPost(db, {
        authorId: author.id,
        status: PostStatus.REJECTED,
        publishedAt: null,
        moderation: {
          verdict: 'spam',
          riskLevel: 3,
          checkedAt: new Date(),
          reviewedById: null,
          reviewedAt: null,
          reviewNote: null,
          evidence: {
            status: 'READY',
            summary: 'Quảng cáo.',
            items: [
              {
                field: 'body',
                category: 'spam',
                reason: 'Mời mua hàng không liên quan.',
                quote: 'mua ngay',
                start: 0,
                end: 8,
                mediaId: null,
                seconds: null,
                imageUrl: null,
              },
            ],
            dropped: 0,
            model: 'anthropic/claude-haiku-5.5',
            createdAt: new Date(),
          },
        },
      });
      const pending = await createPost(db, {
        authorId: author.id,
        status: PostStatus.PENDING_REVIEW,
        publishedAt: null,
        moderation: {
          verdict: 'spam',
          riskLevel: 2,
          checkedAt: new Date(),
          reviewedById: null,
          reviewedAt: null,
          reviewNote: null,
        },
      });
      const rejectedNoModeration = await createPost(db, {
        authorId: author.id,
        status: PostStatus.REJECTED,
        publishedAt: null,
        moderation: null,
      });
      const orphan = await createPost(db, {
        authorId: 'missing-author',
        status: PostStatus.PUBLISHED,
      });

      const dtos = await service.toResponses([
        rejected,
        pending,
        rejectedNoModeration,
        orphan,
      ]);
      expect(dtos).toHaveLength(3);
      expect(dtos[0]).toMatchObject({
        id: rejected.id,
        moderationVerdict: 'spam',
        moderationReason: 'Nội dung spam',
        moderationFindings: [
          {
            field: 'body',
            quote: 'mua ngay',
            reason: 'Mời mua hàng không liên quan.',
            reasonText: 'Nội dung spam',
            mediaId: null,
            seconds: null,
          },
        ],
      });
      expect(dtos[1]).toMatchObject({
        id: pending.id,
        moderationVerdict: null,
        moderationReason: null,
        moderationFindings: [],
      });
      expect(dtos[2]).toMatchObject({
        id: rejectedNoModeration.id,
        moderationVerdict: null,
        moderationReason: null,
      });
    });
  });
});
