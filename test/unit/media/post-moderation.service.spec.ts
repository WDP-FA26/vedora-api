import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { createMedia, createPost, createUser } from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';
import { CloudinaryService } from '../../../src/cloudinary/cloudinary.service.js';
import * as fetchPublicImageModule from '../../../src/common/http/fetch-public-image.js';
import { CaptionService } from '../../../src/media/captions/caption.service.js';
import { PostModerationService } from '../../../src/media/post-moderation.service.js';
import { ContentModerationService } from '../../../src/moderation/content-moderation.service.js';
import {
  CaptionStatus,
  type MediaAsset,
  MediaStatus,
  NotificationType,
  type Post,
  PostStatus,
  PostType,
} from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import { NotificationsService } from '../../../src/notifications/notifications.service.js';
import { StorageService, StorageTarget } from '../../../src/storage/storage.service.js';

vi.mock('../../../src/common/http/fetch-public-image.js', () => ({
  fetchPublicImage: vi.fn(() => Promise.resolve(Buffer.from('img'))),
}));

describe('PostModerationService', () => {
  const fetchPublicImage = vi.mocked(fetchPublicImageModule.fetchPublicImage);
  let app: INestApplication;
  let db: MongoService;
  let service: PostModerationService;
  let review: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let schedule: ReturnType<typeof vi.fn>;
  let keyFromPublicUrl: ReturnType<typeof vi.fn>;
  let getBytes: ReturnType<typeof vi.fn>;
  let active = false;
  const transcribed = new Subject<string>();
  let authorId: string;

  const posts = () => db.connection.model<Post>('Post');
  const assets = () => db.connection.model<MediaAsset>('MediaAsset');

  beforeAll(async () => {
    review = vi.fn();
    notify = vi.fn();
    schedule = vi.fn();
    keyFromPublicUrl = vi.fn();
    getBytes = vi.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('postmod'))],
      providers: [
        PostModerationService,
        CloudinaryService,
        { provide: ContentModerationService, useValue: { review } },
        {
          provide: StorageService,
          useValue: { keyFromPublicUrl, getBytes },
        },
        {
          provide: CaptionService,
          useValue: {
            schedule,
            transcribed,
            get active() {
              return active;
            },
          },
        },
        { provide: NotificationsService, useValue: { notify } },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            CLOUDINARY_CLOUD_NAME: 'demo',
            CLOUDINARY_API_KEY: 'key',
            CLOUDINARY_API_SECRET: 'secret',
          }),
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(PostModerationService);
    authorId = (await createUser(db)).id;
  });

  beforeEach(async () => {
    await posts().deleteMany({});
    await assets().deleteMany({});
    active = false;
    review.mockReset();
    review.mockResolvedValue({
      decision: 'publish',
      category: null,
      violationScore: 0.01,
      scores: { allow: 0.99 },
    });
    notify.mockReset();
    notify.mockResolvedValue(undefined);
    schedule.mockReset();
    keyFromPublicUrl.mockReset();
    keyFromPublicUrl.mockReturnValue(null);
    getBytes.mockReset();
    fetchPublicImage.mockReset();
    fetchPublicImage.mockResolvedValue(Buffer.from('img'));
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  describe('transcribed listener', () => {
    it('moderates a post when captions.transcribed emits and schedules captions on publish', async () => {
      const post = await createPost(db, {
        authorId,
        status: PostStatus.PROCESSING,
        publishedAt: null,
      });

      transcribed.next(post.id);

      await vi.waitFor(async () => {
        expect((await posts().findById(post.id).exec())?.status).toBe(
          PostStatus.PUBLISHED,
        );
      });
      expect(schedule).toHaveBeenCalledOnce();
    });

    it('logs and swallows errors thrown while settling after transcript', async () => {
      const settleSpy = vi
        .spyOn(service, 'settle')
        .mockRejectedValueOnce(new Error('db down'));

      transcribed.next('post-id');

      await vi.waitFor(() => {
        expect(settleSpy).toHaveBeenCalledWith(['post-id']);
      });
      settleSpy.mockRestore();
    });
  });

  describe('decide (admin moderation)', () => {
    it('returns false when post is missing or not in PENDING_REVIEW/REJECTED', async () => {
      await expect(
        service.decide('missing', 'admin-1', 'APPROVE', null),
      ).resolves.toBe(false);

      const published = await createPost(db, {
        authorId,
        status: PostStatus.PUBLISHED,
      });
      await expect(
        service.decide(published.id, 'admin-1', 'APPROVE', null),
      ).resolves.toBe(false);
    });

    it('approves a PENDING_REVIEW post, sets publishedAt, schedules captions, and notifies author', async () => {
      const post = await createPost(db, {
        authorId,
        status: PostStatus.PENDING_REVIEW,
        publishedAt: null,
      });

      const ok = await service.decide(post.id, 'admin-1', 'APPROVE', 'Looks ok');

      expect(ok).toBe(true);
      const updated = await posts().findById(post.id).exec();
      expect(updated).toMatchObject({
        status: PostStatus.PUBLISHED,
        moderation: {
          reviewedById: 'admin-1',
          reviewNote: 'Looks ok',
        },
      });
      expect(updated?.publishedAt).toBeInstanceOf(Date);
      expect(schedule).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith({
        recipientId: authorId,
        type: NotificationType.POST_APPROVED,
        postId: post.id,
        note: 'Looks ok',
      });
    });

    it('preserves existing publishedAt when approving a previously REJECTED post', async () => {
      const originalDate = new Date('2026-01-01T00:00:00Z');
      const post = await createPost(db, {
        authorId,
        status: PostStatus.REJECTED,
        publishedAt: originalDate,
      });

      const ok = await service.decide(post.id, 'admin-2', 'APPROVE', null);

      expect(ok).toBe(true);
      const updated = await posts().findById(post.id).exec();
      expect(updated?.publishedAt?.toISOString()).toBe(
        originalDate.toISOString(),
      );
      expect(notify).toHaveBeenCalledWith({
        recipientId: authorId,
        type: NotificationType.POST_APPROVED,
        postId: post.id,
        note: undefined,
      });
    });

    it('rejects a PENDING_REVIEW post with notification, and avoids duplicate notification when already REJECTED', async () => {
      const pending = await createPost(db, {
        authorId,
        status: PostStatus.PENDING_REVIEW,
        publishedAt: null,
        moderation: {
          verdict: 'harassment',
          violationScore: 0.7,
          scores: { harassment: 0.7 },
          checkedAt: new Date(),
          reviewedById: null,
          reviewedAt: null,
          reviewNote: null,
        },
      });

      expect(
        await service.decide(pending.id, 'admin-1', 'REJECT', 'Rule 2'),
      ).toBe(true);
      expect(notify).toHaveBeenCalledWith({
        recipientId: authorId,
        type: NotificationType.POST_REJECTED,
        postId: pending.id,
        reason: 'harassment',
        note: 'Rule 2',
      });

      notify.mockClear();
      expect(
        await service.decide(pending.id, 'admin-1', 'REJECT', 'Confirmed'),
      ).toBe(true);
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe('settle parts extraction', () => {
    it('moderates blogs with storage cover image and up to 5 deduplicated inline storage images without fetching external URLs', async () => {
      const storagePrefix = 'https://storage.vedora.vn/vedora-blogs/';
      keyFromPublicUrl.mockImplementation((target: StorageTarget, url: string) =>
        target === StorageTarget.Blogs && url.startsWith(storagePrefix)
          ? url.slice(storagePrefix.length)
          : null,
      );
      getBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));

      const markdown = [
        `![cover dup](${storagePrefix}cover.png)`,
        '![external ignored](https://img.test/external.jpg)',
        `![one](${storagePrefix}1.jpg)`,
        `![two](<${storagePrefix}2.jpg> "title")`,
        `![dup](${storagePrefix}1.jpg)`,
        `![three](${storagePrefix}3.jpg)`,
        `![four](${storagePrefix}4.jpg)`,
        `![five](${storagePrefix}5.jpg)`,
        `![six-ignored](${storagePrefix}6.jpg)`,
      ].join('\n');

      const blogPost = await createPost(db, {
        authorId,
        type: PostType.BLOG,
        status: PostStatus.PROCESSING,
        publishedAt: null,
        blog: {
          title: 'Canh chua chay',
          coverImageUrl: `${storagePrefix}cover.png`,
          content: markdown,
          excerpt: '',
          recipeIds: [],
        },
      });

      const published = await service.settle([blogPost.id]);

      expect(published).toBe(1);
      expect(getBytes).toHaveBeenCalledTimes(6);
      expect(getBytes).toHaveBeenCalledWith(StorageTarget.Blogs, 'cover.png');
      expect(getBytes).not.toHaveBeenCalledWith(StorageTarget.Blogs, '6.jpg');
      expect(fetchPublicImage).not.toHaveBeenCalled();
      const parts = review.mock.calls[0]?.[0] as { kind: string }[];
      expect(parts.filter((p) => p.kind === 'text')).toHaveLength(2);
      expect(parts.filter((p) => p.kind === 'image')).toHaveLength(6);
    });

    it('handles a BLOG post with null blog field', async () => {
      const emptyBlog = await createPost(db, {
        authorId,
        type: PostType.BLOG,
        status: PostStatus.PROCESSING,
        publishedAt: null,
        blog: null,
      });

      await expect(service.settle([emptyBlog.id])).resolves.toBe(1);
      expect(review).toHaveBeenCalledWith([]);
    });

    it('proceeds with video frames when captioning failed and keeps post PROCESSING if a frame fails to fetch', async () => {
      const post = await createPost(db, {
        authorId,
        status: PostStatus.PROCESSING,
        publishedAt: null,
        body: 'Video caption',
      });
      await createMedia(db, {
        ownerId: authorId,
        postId: post.id,
        status: MediaStatus.READY,
        durationSec: 20,
        captionStatus: CaptionStatus.FAILED,
      });

      fetchPublicImage.mockResolvedValueOnce(null);
      await expect(service.settle([post.id])).resolves.toBe(0);
      expect((await posts().findById(post.id).exec())?.status).toBe(
        PostStatus.PROCESSING,
      );

      fetchPublicImage.mockResolvedValue(Buffer.from('frame'));
      await expect(service.settle([post.id])).resolves.toBe(1);
      expect((await posts().findById(post.id).exec())?.status).toBe(
        PostStatus.PUBLISHED,
      );
    });
  });
});
