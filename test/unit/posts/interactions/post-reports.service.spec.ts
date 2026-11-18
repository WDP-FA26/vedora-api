import type { INestApplication } from '@nestjs/common';
import { InvalidInputException } from '../../../../src/common/exceptions/invalid-input.exception.js';
import { StateConflictException } from '../../../../src/common/exceptions/state-conflict.exception.js';
import { ResourceNotFoundException } from '../../../../src/common/exceptions/resource-not-found.exception.js';
import { Test } from '@nestjs/testing';
import { createPost, createUser } from '../../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../../support/mongo-test-db.js';
import {
  NotificationType,
  Post,
  PostReport,
  PostReportReason,
  PostReportStatus,
  PostStatus,
  type User,
} from '../../../../src/mongo/models.js';
import { MongoModule } from '../../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../../src/mongo/mongo.service.js';
import { PostReportsService } from '../../../../src/posts/interactions/post-reports.service.js';
import { NotificationsService } from '../../../../src/notifications/notifications.service.js';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';

describe('PostReportsService', () => {
  let app: INestApplication;
  let db: MongoService;
  let service: PostReportsService;
  let author: User;
  let reporter: User;
  let post: Post;
  let notifications: DeepMockProxy<NotificationsService>;

  beforeAll(async () => {
    notifications = mockDeep<NotificationsService>();
    const moduleRef = await Test.createTestingModule({
      imports: [MongoModule.forTest(createTestMongoUrl('reports'))],
      providers: [
        PostReportsService,
        { provide: NotificationsService, useValue: notifications },
      ],
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
    await db.connection.model(PostReport.name).deleteMany({});
    await db.connection.model(Post.name).deleteMany({});
    post = await createPost(db, { authorId: author.id });
    notifications.notify.mockReset();
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
    db.connection.collections[collection].countDocuments();

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
    await expect(file(author.id)).rejects.toBeInstanceOf(InvalidInputException);
    await db.connection
      .model<Post>(Post.name)
      .updateOne({ _id: post.id }, { $set: { status: PostStatus.PROCESSING } });
    await expect(file()).rejects.toBeInstanceOf(ResourceNotFoundException);
    expect(await count('post_reports')).toBe(0);
  });

  it('answers 409 ALREADY_REPORTED for a second report', async () => {
    await file();
    await expect(file()).rejects.toMatchObject({
      code: 'ALREADY_REPORTED',
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
    ).rejects.toBeInstanceOf(StateConflictException);
    await expect(
      service.review(crypto.randomUUID(), author.id, PostReportStatus.RESOLVED),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });

  it('tells the reporter how their report was closed', async () => {
    const dismissed = await file();
    await service.review(dismissed.id, author.id, PostReportStatus.DISMISSED);
    expect(notifications.notify).toHaveBeenLastCalledWith({
      recipientId: reporter.id,
      type: NotificationType.REPORT_DISMISSED,
      postId: post.id,
      reason: PostReportReason.SPAM,
    });

    const other = await createUser(db, { username: 'other.reporter' });
    const resolved = await file(other.id);
    await service.review(resolved.id, author.id, PostReportStatus.RESOLVED);
    expect(notifications.notify).toHaveBeenLastCalledWith({
      recipientId: other.id,
      type: NotificationType.REPORT_RESOLVED,
      postId: post.id,
      reason: PostReportReason.SPAM,
    });
  });

  it('collects the author, reporters and top reason before a removal', async () => {
    const second = await createUser(db, { username: 'second.reporter' });
    const third = await createUser(db, { username: 'third.reporter' });
    await file();
    await service.create(post.id, second.id, {
      reason: PostReportReason.HARMFUL_ADVICE,
    });
    await service.create(post.id, third.id, {
      reason: PostReportReason.HARMFUL_ADVICE,
    });

    const notice = await service.removalNotice(post.id);

    expect(notice).toMatchObject({
      authorId: author.id,
      reason: PostReportReason.HARMFUL_ADVICE,
    });
    expect(notice?.reporterIds.sort()).toEqual(
      [reporter.id, second.id, third.id].sort(),
    );
    await expect(
      service.removalNotice(crypto.randomUUID()),
    ).resolves.toBeNull();
  });

  it('notifies the author and every reporter once a post is removed', async () => {
    await service.announceRemoval(
      {
        authorId: author.id,
        reporterIds: [reporter.id],
        reason: PostReportReason.SPAM,
        excerpt: 'Canh chua',
      },
      'admin-id',
    );
    expect(notifications.notify).toHaveBeenCalledWith({
      recipientId: reporter.id,
      type: NotificationType.REPORTED_POST_REMOVED,
      note: 'Canh chua',
    });
    expect(notifications.notify).toHaveBeenCalledWith({
      recipientId: author.id,
      type: NotificationType.POST_REMOVED,
      reason: PostReportReason.SPAM,
      note: 'Canh chua',
    });

    notifications.notify.mockReset();
    await service.announceRemoval(
      { authorId: author.id, reporterIds: [], reason: null, excerpt: null },
      author.id,
    );
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});
