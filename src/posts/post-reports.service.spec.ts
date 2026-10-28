import type { INestApplication } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createPost, createUser } from '../../test/fixtures';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../test/mongo-test-db';
import {
  type Post,
  PostReportReason,
  PostReportStatus,
  PostStatus,
  type Stored,
  type User,
} from '../mongo/models';
import { MongoModule } from '../mongo/mongo.module';
import { MongoService } from '../mongo/mongo.service';
import { PostReportsService } from './post-reports.service';

describe('PostReportsService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: PostReportsService;
  let author: User;
  let reporter: User;
  let post: Post;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('reports'))],
      providers: [PostReportsService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    db = app.get(MongoService);
    service = app.get(PostReportsService);
    author = await createUser(db, { username: 'author' });
    reporter = await createUser(db, { username: 'reporter' });
  });
  beforeEach(async () => {
    await db.db.collection('post_reports').deleteMany({});
    await db.db.collection<Stored<Post>>('posts').deleteMany({});
    post = await createPost(db, { authorId: author.id });
  });
  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  const file = (reporterId = reporter.id, details?: string) =>
    service.create(post.id, reporterId, {
      reason: PostReportReason.SPAM,
      details,
    });
  const count = (collection: string) =>
    db.db.collection(collection).countDocuments();

  it('files a report against a published post', async () => {
    await expect(file(reporter.id, '')).resolves.toMatchObject({
      postId: post.id,
      reason: 'SPAM',
      details: null,
      status: PostReportStatus.PENDING,
    });
    expect(await count('post_reports')).toBe(1);
  });

  it('refuses reports on missing posts and on your own post', async () => {
    await expect(file(author.id)).rejects.toBeInstanceOf(BadRequestException);
    await db.db
      .collection<Stored<Post>>('posts')
      .updateOne({ _id: post.id }, { $set: { status: PostStatus.PROCESSING } });
    await expect(file()).rejects.toBeInstanceOf(NotFoundException);
    expect(await count('post_reports')).toBe(0);
  });

  it('answers 409 ALREADY_REPORTED for a second report', async () => {
    await file();
    await expect(file()).rejects.toMatchObject({
      response: { code: 'ALREADY_REPORTED' },
    });
    expect(await count('post_reports')).toBe(1);
  });

  it('lists reports with the reporter and the reported post, newest first', async () => {
    await file();
    const page = await service.findAll({ page: 1, limit: 20 });
    expect(page.meta.totalItems).toBe(1);
    expect(page.items[0]).toMatchObject({
      reporter: { username: 'reporter' },
      post: { id: post.id, author: { username: 'author' } },
    });
    const pending = await service.findAll({
      page: 1,
      limit: 20,
      status: PostReportStatus.RESOLVED,
    });
    expect(pending.items).toEqual([]);
  });

  it('closes a pending report once', async () => {
    const { id } = await file();
    await expect(
      service.review(id, author.id, PostReportStatus.DISMISSED),
    ).resolves.toMatchObject({
      status: PostReportStatus.DISMISSED,
      reviewedAt: expect.any(Date) as Date,
    });
    await expect(
      service.review(id, author.id, PostReportStatus.RESOLVED),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.review(crypto.randomUUID(), author.id, PostReportStatus.RESOLVED),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
