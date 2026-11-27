import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { vi } from 'vitest';
import {
  Notification,
  NotificationType,
  Post,
  PostReport,
  PostReportReason,
  PostReportStatus,
  PostStatus,
  PostType,
  User,
  UserRole,
} from '@src/mongo/models.js';
import { NotificationsService } from '@src/notifications/notifications.service.js';
import type { NotificationDto } from '@src/notifications/dto/notification.dto.js';
import { AdminPostsService } from '@src/posts/admin/admin-posts.service.js';
import { PostSearchIndexService } from '@src/posts/search/post-search-index.service.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createPost, createUser } from '@test/support/fixtures.js';

describe('Admin post removal notifications (real MongoDB HTTP)', () => {
  let e2e: E2eApp,
    owner: User,
    admin: User,
    reporter: User,
    token: string,
    ownerToken: string;
  let post: Post;
  const http = () => request(e2e.app.getHttpServer());
  const model = <T>(name: string) => e2e.connection.model<T>(name);
  const remove = (id = post.id, reason?: string, jwt = token) =>
    http()
      .delete(`/api/v1/admin/posts/${id}`)
      .auth(jwt, { type: 'bearer' })
      .send(reason ? { reason } : {});
  const stored = () =>
    model<Notification>(Notification.name).find({
      recipientId: owner.id,
      type: NotificationType.POST_REMOVED,
      postId: post.id,
    });
  const fileReport = (userId = reporter.id, reason = PostReportReason.SPAM) =>
    model<PostReport>(PostReport.name).create({
      postId: post.id,
      reporterId: userId,
      reason,
      details: 'Private reporter information',
    });
  beforeAll(async () => {
    e2e = await createE2eApp('post_removal_notifications');
    owner = await createUser(e2e.mongo);
    admin = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    reporter = await createUser(e2e.mongo);
    token = await e2e.sign(admin);
    ownerToken = await e2e.sign(owner);
  });
  beforeEach(async () => {
    post = await createPost(e2e.mongo, {
      authorId: owner.id,
      body: 'Original vegetarian recipe',
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (e2e) await e2e.close();
  });

  it('notifies the owner with reason, excerpt and a post link even without any reports', async () => {
    const events: NotificationDto[] = [];
    const listener = e2e.app
      .get(NotificationsService)
      .stream(owner.id)
      .subscribe((event) => events.push(event));
    try {
      await remove(post.id, '  Content policy violation  ').expect(204);
      const rows = await stored();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorId: null,
        type: 'POST_REMOVED',
        reason: 'Content policy violation',
        note: 'Original vegetarian recipe',
        postId: post.id,
        readAt: null,
      });
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(rows[0].id);
      expect(await model<Post>(Post.name).findById(post.id)).toMatchObject({
        status: 'REMOVED',
        removal: { reason: 'Content policy violation' },
      });
      await http()
        .get('/api/v1/notifications')
        .auth(ownerToken, { type: 'bearer' })
        .expect(200)
        .expect(({ text }) => {
          const page = JSON.parse(text) as { items: NotificationDto[] };
          expect(
            page.items.some(
              (item) =>
                item.id === rows[0].id &&
                item.type === NotificationType.POST_REMOVED,
            ),
          ).toBe(true);
        });
    } finally {
      listener.unsubscribe();
    }
  });

  it('uses report reason fallback, resolves reports and notifies each reporter without exposing their identity', async () => {
    const other = await createUser(e2e.mongo);
    await fileReport();
    await fileReport(other.id);
    await remove().expect(204);
    const ownerNotice = (await stored())[0];
    expect(ownerNotice.reason).toBe(PostReportReason.SPAM);
    expect(ownerNotice.note).not.toContain('Private reporter information');
    expect(
      await model(PostReport.name).countDocuments({
        postId: post.id,
        status: PostReportStatus.PENDING,
      }),
    ).toBe(0);
    const reporterNotices = await model<Notification>(Notification.name).find({
      type: NotificationType.REPORTED_POST_REMOVED,
      recipientId: { $in: [reporter.id, other.id] },
    });
    expect(reporterNotices).toHaveLength(2);
    expect(reporterNotices.map((row) => row.recipientId).sort()).toEqual(
      [reporter.id, other.id].sort(),
    );
  });

  it('uses a blog title as the bounded notification excerpt', async () => {
    await model<Post>(Post.name).updateOne(
      { _id: post.id },
      {
        $set: {
          type: PostType.BLOG,
          blog: {
            title: 'A vegetarian cookbook',
            content: '<p>Article body</p>',
            excerpt: '',
            recipeIds: [],
            coverImageUrl: null,
          },
        },
      },
    );
    await remove().expect(204);
    expect((await stored())[0].note).toBe('A vegetarian cookbook');
  });

  it('notifies an admin author when they remove their own post', async () => {
    const own = await createPost(e2e.mongo, {
      authorId: admin.id,
      body: 'Admin post',
    });
    await remove(own.id).expect(204);
    expect(
      await model<Notification>(Notification.name).findOne({
        recipientId: admin.id,
        type: NotificationType.POST_REMOVED,
        postId: own.id,
      }),
    ).toMatchObject({ actorId: null, note: 'Admin post' });
  });

  it('creates one notification when removals race and rejects retries without duplicates', async () => {
    const results = await Promise.all([remove(), remove()]);
    expect(results.map((result) => result.status).sort()).toEqual([204, 409]);
    await remove().expect(409);
    expect(await stored()).toHaveLength(1);
  });

  it('rolls back removal and reports when notification persistence fails and emits no event', async () => {
    await fileReport();
    const notices = e2e.app.get(NotificationsService);
    const original = notices.storeSystemNotifications.bind(notices);
    const events: NotificationDto[] = [];
    const listener = notices
      .stream(owner.id)
      .subscribe((event) => events.push(event));
    vi.spyOn(notices, 'storeSystemNotifications').mockImplementationOnce(
      async (inputs, session) => {
        await original(inputs, session);
        throw new Error('Fixture removal notice failure');
      },
    );
    try {
      await expect(
        e2e.app.get(AdminPostsService).remove(post.id, admin.id),
      ).rejects.toThrow('Fixture removal notice failure');
      expect(await model<Post>(Post.name).findById(post.id)).toMatchObject({
        status: PostStatus.PUBLISHED,
        removal: null,
      });
      expect(
        await model(PostReport.name).countDocuments({
          postId: post.id,
          status: PostReportStatus.PENDING,
        }),
      ).toBe(1);
      expect(await stored()).toHaveLength(0);
      expect(events).toHaveLength(0);
    } finally {
      listener.unsubscribe();
    }
  });

  it('publishes the committed owner notification before external search cleanup', async () => {
    const events: NotificationDto[] = [];
    const listener = e2e.app
      .get(NotificationsService)
      .stream(owner.id)
      .subscribe((event) => events.push(event));
    vi.spyOn(
      e2e.app.get(PostSearchIndexService),
      'remove',
    ).mockRejectedValueOnce(new Error('Fixture search cleanup failure'));
    try {
      await expect(
        e2e.app.get(AdminPostsService).remove(post.id, admin.id),
      ).rejects.toThrow('Fixture search cleanup failure');
      expect(await stored()).toHaveLength(1);
      expect(events).toHaveLength(1);
      expect(await model<Post>(Post.name).findById(post.id)).toMatchObject({
        status: PostStatus.REMOVED,
      });
    } finally {
      listener.unsubscribe();
    }
  });

  it('rejects unauthorized removals and missing posts without notifications', async () => {
    await remove(post.id, undefined, ownerToken).expect(403);
    await http().delete(`/api/v1/admin/posts/${post.id}`).expect(401);
    await remove(randomUUID()).expect(404);
    expect(await stored()).toHaveLength(0);
  });

  it('persists another notice for a new removal after restoration', async () => {
    await remove().expect(204);
    await http()
      .post(`/api/v1/admin/posts/${post.id}/restore`)
      .auth(token, { type: 'bearer' })
      .send({})
      .expect(200);
    await remove().expect(204);
    expect(await stored()).toHaveLength(2);
  });
});
