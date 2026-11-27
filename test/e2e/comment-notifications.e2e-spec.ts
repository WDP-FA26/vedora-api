import { commentReviewVersion } from '@src/posts/interactions/comment-review-version.js';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Subscription } from 'rxjs';
import { MongoServerError } from 'mongodb';
import {
  CommentReport,
  Notification,
  NotificationType,
  Post,
  PostComment,
  PostReportStatus,
  User,
  UserRole,
} from '@src/mongo/models.js';
import { NotificationsService } from '@src/notifications/notifications.service.js';
import type { NotificationDto } from '@src/notifications/dto/notification.dto.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createPost, createUser } from '@test/support/fixtures.js';
import {
  SYSTEM_ACCOUNT,
  SYSTEM_ACCOUNT_ID,
} from '@src/users/system-account.js';

describe('Comment removal and report notifications (real MongoDB HTTP)', () => {
  let e2e: E2eApp;
  let owner: User, author: User, replier: User, reporter: User, admin: User;
  let post: Post, root: PostComment;
  let notices: NotificationsService;
  const subscriptions: Subscription[] = [];
  const model = <T>(name: string) => e2e.connection.model<T>(name);
  const comments = () => model<PostComment>(PostComment.name);
  const notifications = () => model<Notification>(Notification.name);
  const server = () => e2e.app.getHttpServer();
  const auth = async (user: User, req: request.Test) =>
    req.auth(await e2e.sign(user), { type: 'bearer' });
  const remove = (user = admin, id = root.id) =>
    auth(
      user,
      request(server()).delete(`/api/v1/posts/${post.id}/comments/${id}`),
    );
  const report = async (user = reporter, commentId = root.id) => {
    const response = await auth(
      user,
      request(server())
        .post(`/api/v1/posts/${post.id}/comments/${commentId}/report`)
        .send({ reason: 'HARASSMENT', details: 'Private reporter details' }),
    );
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  };
  const review = async (id: string, action = 'REMOVE', user = admin) => {
    const row = await model<CommentReport>(CommentReport.name).findById(id);
    const comment = row ? await comments().findById(row.commentId) : null;
    return auth(
      user,
      request(server())
        .post(`/api/v1/admin/comment-reports/${id}/review`)
        .send({
          action,
          ...(action === 'REMOVE'
            ? {
                expectedCommentVersion: comment
                  ? commentReviewVersion(comment)
                  : null,
              }
            : {}),
        }),
    );
  };
  const stored = () => notifications().find({ postId: post.id }).exec();
  const listen = (user: User) => {
    const events: NotificationDto[] = [];
    subscriptions.push(
      notices.stream(user.id).subscribe((event) => events.push(event)),
    );
    return events;
  };
  const reply = (user = replier, body = 'A reply') =>
    comments().create({
      postId: post.id,
      authorId: user.id,
      parentId: root.id,
      replyToId: root.id,
      body,
    });

  beforeAll(async () => {
    e2e = await createE2eApp('comment_notifications');
    notices = e2e.app.get(NotificationsService);
  });
  beforeEach(async () => {
    [owner, author, replier, reporter, admin] = await Promise.all([
      createUser(e2e.mongo),
      createUser(e2e.mongo),
      createUser(e2e.mongo),
      createUser(e2e.mongo),
      createUser(e2e.mongo, { role: UserRole.ADMIN }),
    ]);
    post = await createPost(e2e.mongo, { authorId: owner.id });
    root = await comments().create({
      postId: post.id,
      authorId: author.id,
      body: 'Original comment',
    });
  });
  afterEach(() => {
    for (const subscription of subscriptions.splice(0))
      subscription.unsubscribe();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    if (e2e) await e2e.close();
  });

  it('notifies the author and reporter after an admin removes a reported comment', async () => {
    const id = await report();
    const authorEvents = listen(author),
      reporterEvents = listen(reporter),
      otherEvents = listen(owner);
    expect((await review(id)).status).toBe(200);
    const rows = await stored();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.recipientId === author.id)).toMatchObject({
      type: 'COMMENT_REMOVED',
      actorId: null,
      commentId: null,
      reason: 'HARASSMENT',
      note: root.body,
    });
    expect(rows.find((r) => r.recipientId === reporter.id)).toMatchObject({
      type: 'COMMENT_REPORT_RESOLVED',
      actorId: null,
      commentId: null,
    });
    expect(authorEvents).toHaveLength(1);
    expect(reporterEvents).toHaveLength(1);
    expect(otherEvents).toHaveLength(0);
    expect(JSON.stringify(authorEvents)).not.toContain(reporter.id);
    expect(JSON.stringify(authorEvents)).not.toContain(
      'Private reporter details',
    );
    expect(authorEvents[0]).not.toHaveProperty('recipientId');
  });

  it('dismisses only the selected report, notifying its reporter but not the comment author', async () => {
    const id = await report();
    const authorEvents = listen(author),
      reporterEvents = listen(reporter);
    expect((await review(id, 'DISMISS')).status).toBe(200);
    expect(await comments().exists({ _id: root.id })).not.toBeNull();
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'COMMENT_REPORT_DISMISSED',
      recipientId: reporter.id,
      commentId: null,
    });
    expect(authorEvents).toHaveLength(0);
    expect(reporterEvents).toHaveLength(1);
  });

  it('groups cascaded replies by author and distinguishes them from the violating root', async () => {
    const a = await reply(replier, 'First collateral reply');
    await reply(replier, 'Second collateral reply');
    await reply(author, 'The root author also replied');
    await reply(admin, 'The admin also replied');
    const id = await report();
    await report(reporter, a.id);
    expect((await review(id)).status).toBe(200);
    const rows = await stored();
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.recipientId === author.id)).toHaveLength(1);
    expect(rows.find((r) => r.recipientId === replier.id)).toMatchObject({
      type: 'COMMENT_THREAD_REMOVED',
      reason: null,
    });
    expect(rows.filter((r) => r.recipientId === reporter.id)).toHaveLength(1);
    expect(rows.filter((r) => r.recipientId === admin.id)).toHaveLength(0);
    expect(await comments().countDocuments({ postId: post.id })).toBe(0);
  });

  it('notifies each reporter once when several people reported the same comment', async () => {
    const second = await createUser(e2e.mongo);
    const id = await report();
    await report(second);
    expect((await review(id)).status).toBe(200);
    const rows = await stored();
    expect(
      rows
        .filter((r) => r.type === NotificationType.COMMENT_REPORT_RESOLVED)
        .map((r) => r.recipientId)
        .sort(),
    ).toEqual([reporter.id, second.id].sort());
  });

  it('notifies only the reporter when the target was already deleted', async () => {
    const id = await report();
    expect((await remove(author)).status).toBe(204);
    expect(await stored()).toHaveLength(0);
    expect((await review(id)).status).toBe(200);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe(NotificationType.COMMENT_REPORT_RESOLVED);
  });

  it('avoids a broken post/comment link when the post no longer exists', async () => {
    const id = await report();
    await e2e.mongo.withTransaction((session) =>
      model<Post>(Post.name).deleteOne({ _id: post.id }, { session }).exec(),
    );
    expect((await review(id)).status).toBe(200);
    const rows = await notifications()
      .find({ recipientId: reporter.id })
      .exec();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      postId: null,
      commentId: null,
      note: root.body,
    });
  });

  it('does not create notices for a reporter whose account was deleted', async () => {
    const id = await report();
    await e2e.mongo.withTransaction((session) =>
      model<User>(User.name)
        .deleteOne({ _id: reporter.id }, { session })
        .exec(),
    );
    expect((await review(id)).status).toBe(200);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].recipientId).toBe(author.id);
  });

  it('sends nothing for failed/unauthorized decisions', async () => {
    const id = await report();
    const events = listen(author);
    expect((await review(id, 'REMOVE', reporter)).status).toBe(403);
    expect((await review(id, 'UNKNOWN')).status).toBe(400);
    expect((await review(randomUUID())).status).toBe(404);
    expect(await stored()).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('prevents duplicate notices when two admins review the same report', async () => {
    const id = await report();
    const second = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    const events = listen(reporter);
    const responses = await Promise.all([
      review(id),
      review(id, 'REMOVE', second),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await stored()).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect((await review(id)).status).toBe(409);
    expect(await stored()).toHaveLength(2);
  });

  it('rolls back removal and status if notification persistence fails, with no realtime event', async () => {
    const id = await report();
    const events = listen(author);
    const spy = vi
      .spyOn(notifications(), 'create')
      .mockRejectedValueOnce(new Error('Injected notification failure'));
    expect((await review(id)).status).toBe(500);
    spy.mockRestore();
    expect(await comments().exists({ _id: root.id })).not.toBeNull();
    expect(
      (await model<CommentReport>(CommentReport.name).findById(id))?.status,
    ).toBe(PostReportStatus.PENDING);
    expect(await stored()).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect((await review(id)).status).toBe(200);
    expect(await stored()).toHaveLength(2);
    expect(events).toHaveLength(1);
  });

  it('keeps committed notices available when realtime publishing fails', async () => {
    const id = await report();
    const settings =
      await import('@src/moderation/moderation-settings.service.js');
    const spy = vi
      .spyOn(e2e.app.get(settings.ModerationSettingsService), 'reasonTexts')
      .mockRejectedValueOnce(new Error('Injected realtime lookup failure'));
    expect((await review(id)).status).toBe(200);
    spy.mockRestore();
    expect(await stored()).toHaveLength(2);
    const response = await auth(
      author,
      request(server()).get('/api/v1/notifications'),
    );
    expect(response.status).toBe(200);
    expect((response.body as { items: NotificationDto[] }).items[0].type).toBe(
      NotificationType.COMMENT_REMOVED,
    );
  });

  it('distinguishes the post owner removing a comment from admin enforcement', async () => {
    expect((await remove(owner)).status).toBe(204);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientId: author.id,
      type: 'COMMENT_REMOVED_BY_POST_OWNER',
      reason: null,
    });
  });

  it('notifies direct admin deletions through the normal comment endpoint', async () => {
    expect((await remove()).status).toBe(204);
    expect((await stored())[0]).toMatchObject({
      recipientId: author.id,
      type: 'COMMENT_REMOVED',
    });
  });

  it('self-deletion does not notify the actor but notifies authors of cascaded replies', async () => {
    await reply();
    await reply();
    const events = listen(replier);
    expect((await remove(author)).status).toBe(204);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientId: replier.id,
      type: 'COMMENT_THREAD_REMOVED',
    });
    expect(events).toHaveLength(1);
  });

  it('removing a reply leaves siblings and their authors without collateral notifications', async () => {
    const a = await reply();
    await reply(author);
    const id = await report(reporter, a.id);
    expect((await review(id)).status).toBe(200);
    const rows = await stored();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.recipientId === replier.id)?.type).toBe(
      NotificationType.COMMENT_REMOVED,
    );
    expect(rows.filter((r) => r.recipientId === author.id)).toHaveLength(0);
    expect(await comments().countDocuments({ postId: post.id })).toBe(2);
  });

  it('stores bounded excerpts, updates unread counts and supports marking the notice read', async () => {
    await comments().updateOne(
      { _id: root.id },
      { $set: { body: 'x'.repeat(200) } },
    );
    const id = await report();
    expect((await review(id)).status).toBe(200);
    const row = await notifications().findOne({ recipientId: author.id });
    expect(row?.note).toHaveLength(80);
    expect(row?.note?.endsWith('…')).toBe(true);
    const unread = await auth(
      author,
      request(server()).get('/api/v1/notifications/unread-count'),
    );
    expect(unread.body).toMatchObject({ unreadCount: 1 });
    const read = await auth(
      author,
      request(server()).post(`/api/v1/notifications/${row!.id}/read`),
    );
    expect(read.status).toBe(204);
  });

  it('does not notify an admin about their own report decision', async () => {
    const id = await report(admin);
    expect((await review(id)).status).toBe(200);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].recipientId).toBe(author.id);
  });

  it('does not send unread notices to the system account', async () => {
    await model<User>(User.name).updateOne(
      { _id: SYSTEM_ACCOUNT_ID },
      { $setOnInsert: { ...SYSTEM_ACCOUNT, _id: SYSTEM_ACCOUNT_ID } },
      { upsert: true },
    );
    await comments().updateOne(
      { _id: root.id },
      { $set: { authorId: SYSTEM_ACCOUNT_ID } },
    );
    const id = await report();
    expect((await review(id)).status).toBe(200);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].recipientId).toBe(reporter.id);
  });

  it('keeps a dismissal outcome after the comment is deleted later', async () => {
    const id = await report();
    expect((await review(id, 'DISMISS')).status).toBe(200);
    const notice = await notifications().findOne({ recipientId: reporter.id });
    expect((await remove(owner)).status).toBe(204);
    expect(await notifications().exists({ _id: notice!.id })).not.toBeNull();
  });

  it('rolls back ordinary deletion on notification failure and allows a clean retry', async () => {
    const events = listen(author);
    const spy = vi
      .spyOn(notifications(), 'create')
      .mockRejectedValueOnce(
        new Error('Injected ordinary deletion notice failure'),
      );
    expect((await remove(owner)).status).toBe(500);
    spy.mockRestore();
    expect(await comments().exists({ _id: root.id })).not.toBeNull();
    expect(await stored()).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect((await remove(owner)).status).toBe(204);
    expect(await stored()).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('publishes only the committed notices after a transient transaction retry', async () => {
    const id = await report();
    const events = listen(author);
    const original = notices.storeSystemNotifications.bind(notices);
    const spy = vi
      .spyOn(notices, 'storeSystemNotifications')
      .mockImplementationOnce(async (inputs, session) => {
        await original(inputs, session);
        const error = new MongoServerError({
          message: 'Injected transient write conflict',
          code: 112,
        });
        error.addErrorLabel('TransientTransactionError');
        throw error;
      });
    expect((await review(id)).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await stored()).toHaveLength(2);
    expect(events).toHaveLength(1);
  });
});
