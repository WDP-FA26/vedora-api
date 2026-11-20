import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { StateConflictException } from '../../../../src/common/exceptions/state-conflict.exception.js';
import { ResourceNotFoundException } from '../../../../src/common/exceptions/resource-not-found.exception.js';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import {
  createMedia,
  createPost,
  createUser,
} from '../../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../../support/mongo-test-db.js';
import { MediaService } from '../../../../src/media/media.service.js';
import { PostModerationService } from '../../../../src/media/post-moderation.service.js';
import {
  CaptionStatus,
  MediaStatus,
  type Post,
  PostComment,
  PostLike,
  PostRemovalActor,
  PostStatus,
} from '../../../../src/mongo/models.js';
import { MongoModule } from '../../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../../src/mongo/mongo.service.js';
import { AdminPostsService } from '../../../../src/posts/admin/admin-posts.service.js';
import { PostRelationsService } from '../../../../src/posts/post-relations.service.js';
import { PostReportsService } from '../../../../src/posts/interactions/post-reports.service.js';
import { CaptionService } from '../../../../src/media/captions/caption.service.js';
import { NotificationsService } from '../../../../src/notifications/notifications.service.js';
import { PostSearchIndexService } from '../../../../src/posts/search/post-search-index.service.js';
import { SupportSyncService } from '../../../../src/support/support-sync.service.js';

describe('AdminPostsService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: AdminPostsService;
  let mediaService: DeepMockProxy<MediaService>;
  let postModeration: DeepMockProxy<PostModerationService>;
  let searchIndex: DeepMockProxy<PostSearchIndexService>;
  let reports: DeepMockProxy<PostReportsService>;
  let post: Post;

  beforeAll(async () => {
    mediaService = mockDeep<MediaService>();
    postModeration = mockDeep<PostModerationService>();
    searchIndex = mockDeep<PostSearchIndexService>();
    reports = mockDeep<PostReportsService>();
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
      captions: item.captions.map(
        ({ languageCode, name, isOriginal, url }) => ({
          languageCode,
          name,
          isOriginal,
          url,
        }),
      ),
    }));
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('adminposts'))],
      providers: [
        AdminPostsService,
        PostRelationsService,
        { provide: MediaService, useValue: mediaService },
        {
          provide: PostModerationService,
          useValue: postModeration,
        },
        { provide: PostReportsService, useValue: reports },
        { provide: PostSearchIndexService, useValue: searchIndex },
        { provide: CaptionService, useValue: mockDeep<CaptionService>() },
        {
          provide: NotificationsService,
          useValue: mockDeep<NotificationsService>(),
        },
        SupportSyncService,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(AdminPostsService);

    const comments = app.get<Model<PostComment>>(
      getModelToken(PostComment.name),
    );
    const likes = app.get<Model<PostLike>>(getModelToken(PostLike.name));
    const author = await createUser(db, { username: 'vedora.chef' });
    post = await createPost(db, {
      authorId: author.id,
      status: PostStatus.PROCESSING,
      publishedAt: null,
      body: 'Đậu hũ sốt cà',
      viewCount: 7,
    });
    await createPost(db, { authorId: author.id, status: PostStatus.FAILED });
    await createMedia(db, {
      postId: post.id,
      status: MediaStatus.READY,
      captionStatus: CaptionStatus.READY,
      captionLanguage: 'vi',
      captions: [
        {
          languageCode: 'vi',
          name: 'Tiếng Việt',
          isOriginal: true,
          url: 'https://res.cloudinary.com/demo/raw/upload/vi.vtt',
        },
      ],
    });
    const reader = await createUser(db);
    await comments.create({
      postId: post.id,
      authorId: reader.id,
      body: 'Ngon',
    });
    await likes.create({ postId: post.id, userId: reader.id });
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('lists posts of every status with their caption state', async () => {
    const page = await service.findAll({ page: 1, limit: 20 });

    expect(page.meta.totalItems).toBe(2);
    expect(page.items.find(({ id }) => id === post.id)).toMatchObject({
      status: PostStatus.PROCESSING,
      commentCount: 1,
      likeCount: 1,
      viewCount: 7,
      media: [{ captionStatus: CaptionStatus.READY, captionLanguage: 'vi' }],
    });
  });

  it('filters by status', async () => {
    const page = await service.findAll({
      page: 1,
      limit: 20,
      status: PostStatus.FAILED,
    });
    expect(page.meta.totalItems).toBe(1);
    expect(page.items[0].status).toBe(PostStatus.FAILED);
  });

  it("includes each video's caption tracks in a single post", async () => {
    const found = await service.findOne(post.id);

    expect(found.media[0]).toMatchObject({
      captionStatus: CaptionStatus.READY,
      captions: [{ languageCode: 'vi', isOriginal: true }],
    });
  });

  it('answers 404 for an unknown post', async () => {
    await expect(service.findOne(crypto.randomUUID())).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it('moderates a post, handles missing/non-reviewable posts, and forwards optional notes', async () => {
    const adminId = crypto.randomUUID();
    await expect(
      service.moderate(crypto.randomUUID(), adminId, 'APPROVE', 'ok'),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);

    postModeration.decide.mockResolvedValueOnce(false);
    await expect(
      service.moderate(post.id, adminId, 'APPROVE', undefined),
    ).rejects.toBeInstanceOf(StateConflictException);
    expect(postModeration.decide).toHaveBeenCalledWith(
      post.id,
      adminId,
      'APPROVE',
      null,
    );

    postModeration.decide.mockResolvedValueOnce(true);
    const moderated = await service.moderate(
      post.id,
      adminId,
      'REJECT',
      'Policy violation',
    );
    expect(moderated.id).toBe(post.id);
    expect(postModeration.decide).toHaveBeenCalledWith(
      post.id,
      adminId,
      'REJECT',
      'Policy violation',
    );
  });

  it('reads who to notify before soft-deleting a post, then notifies them', async () => {
    const author = await createUser(db);
    const target = await createPost(db, { authorId: author.id });
    const notice = {
      authorId: 'author',
      reporterIds: ['reporter'],
      reason: null,
      excerpt: 'Soup',
    };
    const order: string[] = [];
    reports.removalNotice.mockImplementation(() => {
      order.push('notice');
      return Promise.resolve(notice);
    });
    searchIndex.remove.mockImplementation(() => {
      order.push('unindex');
      return Promise.resolve();
    });
    reports.announceRemoval.mockImplementation(() => {
      order.push('announce');
      return Promise.resolve();
    });

    await service.remove(target.id, 'admin', '  Spam  ');

    expect(order).toEqual(['notice', 'unindex', 'announce']);
    expect(reports.announceRemoval).toHaveBeenCalledWith(
      notice,
      'admin',
      'Spam',
    );
    const removed = await db.connection
      .model<Post>('Post')
      .findOne({ _id: target.id })
      .exec();
    expect(removed?.status).toBe(PostStatus.REMOVED);
    expect(removed?.removal?.removedByRole).toBe(PostRemovalActor.ADMIN);
    expect(removed?.removal?.reason).toBe('Spam');
    await expect(service.remove(target.id, 'admin')).rejects.toBeInstanceOf(
      StateConflictException,
    );
  });
});
