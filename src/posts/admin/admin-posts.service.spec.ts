import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { ResourceNotFoundException } from '../../common/exceptions/resource-not-found.exception.js';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { createMedia, createPost, createUser } from '../../../test/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../../test/mongo-test-db.js';
import { MediaService } from '../../media/media.service.js';
import {
  CaptionStatus,
  MediaStatus,
  type Post,
  PostComment,
  PostLike,
  PostStatus,
} from '../../mongo/models.js';
import { MongoModule } from '../../mongo/mongo.module.js';
import { MongoService } from '../../mongo/mongo.service.js';
import { AdminPostsService } from './admin-posts.service.js';
import { PostRelationsService } from '../post-relations.service.js';

describe('AdminPostsService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: AdminPostsService;
  let mediaService: DeepMockProxy<MediaService>;
  let post: Post;

  beforeAll(async () => {
    mediaService = mockDeep<MediaService>();
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
});
