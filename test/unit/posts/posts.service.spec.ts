import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { AccessDeniedException } from '../../../src/common/exceptions/access-denied.exception.js';
import { InvalidInputException } from '../../../src/common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../../src/common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../../../src/common/exceptions/state-conflict.exception.js';
import { MediaService } from '../../../src/media/media.service.js';
import {
  MediaAsset,
  Post,
  PostRemovalActor,
  PostStatus,
  PostType,
  type User,
} from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import type { PostResponseDto } from '../../../src/posts/dto/post-response.dto.js';
import { PostsQueryService } from '../../../src/posts/posts-query.service.js';
import { PostsService } from '../../../src/posts/posts.service.js';
import { PostSearchIndexService } from '../../../src/posts/search/post-search-index.service.js';
import { createMedia, createPost, createUser } from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

describe('PostsService', () => {
  let app: INestApplication;
  let db: MongoService;
  let postsModel: Model<Post>;
  let service: PostsService;
  let postsQuery: DeepMockProxy<PostsQueryService>;
  let mediaService: DeepMockProxy<MediaService>;
  let searchIndex: DeepMockProxy<PostSearchIndexService>;
  let author: User;
  let other: User;

  beforeAll(async () => {
    postsQuery = mockDeep<PostsQueryService>();
    mediaService = mockDeep<MediaService>();
    searchIndex = mockDeep<PostSearchIndexService>();

    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('postsservice'))],
      providers: [
        PostsService,
        { provide: PostsQueryService, useValue: postsQuery },
        { provide: MediaService, useValue: mediaService },
        { provide: PostSearchIndexService, useValue: searchIndex },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    postsModel = app.get(getModelToken(Post.name));
    service = app.get(PostsService);
    author = await createUser(db, { username: 'chef.author' });
    other = await createUser(db, { username: 'chef.other' });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    postsQuery.load.mockImplementation((id) =>
      Promise.resolve({ id } as PostResponseDto),
    );
    mediaService.claimForPost.mockResolvedValue();
    mediaService.settlePosts.mockResolvedValue();
    mediaService.discard.mockResolvedValue();
    mediaService.replacePostMedia.mockResolvedValue({
      changed: false,
      detachedIds: [],
    });
    searchIndex.remove.mockResolvedValue();
  });

  afterEach(async () => {
    await Promise.all([
      db.connection.model(Post.name).deleteMany({}),
      db.connection.model(MediaAsset.name).deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  describe('create', () => {
    it('rejects an empty post with no body and no mediaIds', async () => {
      await expect(
        service.create(author.id, { type: PostType.POST, body: '' }),
      ).rejects.toMatchObject({ code: 'EMPTY_POST' });
      expect(mediaService.claimForPost).not.toHaveBeenCalled();
    });

    it('creates a PROCESSING text post, claims media, settles, and schedules indexing', async () => {
      const result = await service.create(author.id, {
        type: PostType.POST,
        body: 'Đậu hũ sốt cà',
        mediaIds: ['m1'],
      });

      const saved = await postsModel.findOne({ _id: result.id }).exec();
      expect(saved).toMatchObject({
        authorId: author.id,
        type: PostType.POST,
        status: PostStatus.PROCESSING,
        body: 'Đậu hũ sốt cà',
        searchIndexedAt: null,
        viewCount: 0,
        publishedAt: null,
      });
      expect(mediaService.claimForPost).toHaveBeenCalledWith(
        expect.anything(),
        author.id,
        result.id,
        ['m1'],
      );
      expect(mediaService.settlePosts).toHaveBeenCalledWith([result.id]);
      expect(searchIndex.schedule).toHaveBeenCalledOnce();
      expect(postsQuery.load).toHaveBeenCalledWith(result.id, author.id);
    });

    it('allows creating a video-only post with undefined body', async () => {
      const result = await service.create(author.id, {
        type: PostType.POST,
        mediaIds: ['m1'],
      });

      const saved = await postsModel.findOne({ _id: result.id }).exec();
      expect(saved?.body).toBeNull();
    });
  });

  describe('update', () => {
    it('rejects an empty update payload', async () => {
      await expect(
        service.update('any-id', author.id, {}),
      ).rejects.toBeInstanceOf(InvalidInputException);
    });

    it('rejects missing posts, blogs, non-authors, and PROCESSING posts', async () => {
      await expect(
        service.update('missing-id', author.id, { body: 'hi' }),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      const blog = await createPost(db, {
        authorId: author.id,
        type: PostType.BLOG,
        status: PostStatus.PUBLISHED,
      });
      await expect(
        service.update(blog.id, author.id, { body: 'hi' }),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      const post = await createPost(db, {
        authorId: author.id,
        status: PostStatus.PUBLISHED,
        body: 'Original',
      });
      await expect(
        service.update(post.id, other.id, { body: 'Hacked' }),
      ).rejects.toBeInstanceOf(AccessDeniedException);

      const processing = await createPost(db, {
        authorId: author.id,
        status: PostStatus.PROCESSING,
        body: 'Wait',
      });
      await expect(
        service.update(processing.id, author.id, { body: 'New' }),
      ).rejects.toBeInstanceOf(StateConflictException);
    });

    it('rejects edits that leave neither text nor media', async () => {
      const post = await createPost(db, {
        authorId: author.id,
        status: PostStatus.PUBLISHED,
        body: 'Text',
      });

      await expect(
        service.update(post.id, author.id, { body: '' }),
      ).rejects.toMatchObject({ code: 'EMPTY_POST' });

      await createMedia(db, { postId: post.id });
      await expect(
        service.update(post.id, author.id, { body: '', mediaIds: [] }),
      ).rejects.toMatchObject({ code: 'EMPTY_POST' });
    });

    it('returns the post untouched when nothing actually changed', async () => {
      const post = await createPost(db, {
        authorId: author.id,
        status: PostStatus.PUBLISHED,
        body: 'Unchanged',
        searchIndexedAt: new Date(),
      });

      await service.update(post.id, author.id, { body: 'Unchanged' });

      const reloaded = await postsModel.findOne({ _id: post.id }).exec();
      expect(reloaded?.status).toBe(PostStatus.PUBLISHED);
      expect(mediaService.settlePosts).not.toHaveBeenCalled();
      expect(searchIndex.schedule).not.toHaveBeenCalled();
    });

    it('resets a REJECTED/PUBLISHED post to PROCESSING when body or media changes and discards detached media', async () => {
      const post = await createPost(db, {
        authorId: author.id,
        status: PostStatus.REJECTED,
        body: 'Bad text',
        searchIndexedAt: new Date(),
        moderation: {
          verdict: 'harassment',
          violationScore: 0.9,
          scores: { harassment: 0.9 },
          checkedAt: new Date(),
          reviewedById: null,
          reviewedAt: null,
          reviewNote: null,
        },
      });
      mediaService.replacePostMedia.mockResolvedValue({
        changed: true,
        detachedIds: ['old-media-1'],
      });

      await service.update(post.id, author.id, {
        body: 'Clean text',
        mediaIds: ['new-media-1'],
      });

      const reloaded = await postsModel.findOne({ _id: post.id }).exec();
      expect(reloaded?.status).toBe(PostStatus.PROCESSING);
      expect(reloaded?.body).toBe('Clean text');
      expect(reloaded?.moderation).toBeNull();
      expect(reloaded?.searchIndexedAt).toBeNull();
      expect(mediaService.settlePosts).toHaveBeenCalledWith([post.id]);
      expect(searchIndex.schedule).toHaveBeenCalledOnce();
      expect(mediaService.discard).toHaveBeenCalledWith({
        _id: { $in: ['old-media-1'] },
      });
    });

    it('clears body to null when media remains on the post', async () => {
      const post = await createPost(db, {
        authorId: author.id,
        status: PostStatus.FAILED,
        body: 'Old caption',
      });
      await createMedia(db, { postId: post.id });

      await service.update(post.id, author.id, { body: '' });

      const reloaded = await postsModel.findOne({ _id: post.id }).exec();
      expect(reloaded?.body).toBeNull();
      expect(reloaded?.status).toBe(PostStatus.PROCESSING);
    });
  });

  describe('remove', () => {
    it('enforces ownership and soft-deletes the post for its author', async () => {
      await expect(service.remove('missing', author.id)).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );

      const post = await createPost(db, {
        authorId: author.id,
        body: 'To delete',
      });
      await createMedia(db, { postId: post.id });

      await expect(service.remove(post.id, other.id)).rejects.toBeInstanceOf(
        AccessDeniedException,
      );

      await service.remove(post.id, author.id);

      const removed = await postsModel.findOne({ _id: post.id }).exec();
      expect(removed?.status).toBe(PostStatus.REMOVED);
      expect(removed?.removal?.removedByRole).toBe(PostRemovalActor.AUTHOR);
      expect(removed?.removal?.previousStatus).toBe(post.status);
      expect(searchIndex.remove).toHaveBeenCalledWith(post.id);
      // Media stays so an admin can still review or restore the post.
      expect(mediaService.discard).not.toHaveBeenCalled();
      await expect(service.remove(post.id, author.id)).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
    });
  });
});
