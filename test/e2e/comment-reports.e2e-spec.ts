import { commentReviewVersion } from '@src/posts/interactions/comment-review-version.js';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  AccountStatus,
  CommentReport,
  Notification,
  NotificationType,
  PostComment,
  PostReportStatus,
  PostStatus,
  User,
  UserRole,
} from '@src/mongo/models.js';
import type {
  AdminCommentReportDto,
  CommentReportDto,
} from '@src/posts/dto/comment-report.dto.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createPost, createUser } from '@test/support/fixtures.js';

describe('Comment reporting and admin handling (real MongoDB HTTP)', () => {
  let e2e: E2eApp;
  let author: User;
  let reporter: User;
  let admin: User;
  let otherAdmin: User;
  let authorToken: string;
  let token: string;
  let adminToken: string;
  let otherAdminToken: string;
  const model = <T>(name: string) => e2e.connection.model<T>(name);
  const reports = () => model<CommentReport>(CommentReport.name);
  const comments = () => model<PostComment>(PostComment.name);
  const server = () => e2e.app.getHttpServer();
  const reportUrl = (postId: string, commentId: string) =>
    `/api/v1/posts/${postId}/comments/${commentId}/report`;
  const submit = (
    postId: string,
    commentId: string,
    jwt = token,
    body: object = { reason: 'HARASSMENT', details: '  Xin admin kiểm tra  ' },
  ) =>
    request(server())
      .post(reportUrl(postId, commentId))
      .auth(jwt, { type: 'bearer' })
      .send(body);
  const review = async (id: string, action = 'REMOVE', jwt = adminToken) => {
    const row = await reports().findById(id);
    const comment = row ? await comments().findById(row.commentId) : null;
    return request(server())
      .post(`/api/v1/admin/comment-reports/${id}/review`)
      .auth(jwt, { type: 'bearer' })
      .send({
        action,
        ...(action === 'REMOVE'
          ? {
              expectedCommentVersion: comment
                ? commentReviewVersion(comment)
                : null,
            }
          : {}),
      });
  };
  const expectReview = async (
    response: Promise<request.Response>,
    status: number,
  ) => {
    const result = await response;
    expect(result.status).toBe(status);
    return result;
  };
  const list = (suffix = '') =>
    request(server())
      .get(`/api/v1/admin/comment-reports${suffix}`)
      .auth(adminToken, { type: 'bearer' });
  const fixture = async (status = PostStatus.PUBLISHED) => {
    const post = await createPost(e2e.mongo, { authorId: author.id, status });
    const root = await comments().create({
      postId: post.id,
      authorId: author.id,
      body: 'Nội dung cần admin kiểm tra',
    });
    return { post, root };
  };
  const createReport = async (
    postId: string,
    commentId: string,
    jwt = token,
  ) => {
    const response = await submit(postId, commentId, jwt).expect(201);
    return response.body as CommentReportDto;
  };

  beforeAll(async () => {
    e2e = await createE2eApp('comment_reports');
    author = await createUser(e2e.mongo);
    reporter = await createUser(e2e.mongo);
    admin = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    otherAdmin = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    [authorToken, token, adminToken, otherAdminToken] = await Promise.all(
      [author, reporter, admin, otherAdmin].map((u) => e2e.sign(u)),
    );
  });
  afterAll(async () => {
    if (e2e) await e2e.close();
  });

  it('requires authentication and only admins can read/review reports', async () => {
    const { post, root } = await fixture();
    await request(server())
      .post(reportUrl(post.id, root.id))
      .send({ reason: 'SPAM' })
      .expect(401);
    const row = await createReport(post.id, root.id);
    await request(server()).get('/api/v1/admin/comment-reports').expect(401);
    await request(server())
      .get('/api/v1/admin/comment-reports')
      .auth(token, { type: 'bearer' })
      .expect(403);
    await expectReview(review(row.id, 'REMOVE', token), 403);
    expect(await comments().exists({ _id: root.id })).not.toBeNull();
  });

  it('validates UUIDs, reasons, detail length, review actions and query status', async () => {
    const { post, root } = await fixture();
    await submit(post.id, 'invalid').expect(400);
    await submit(post.id, root.id, token, { reason: 'INVALID' }).expect(400);
    await submit(post.id, root.id, token, {
      reason: 'SPAM',
      details: 'x'.repeat(501),
    }).expect(400);
    await submit(post.id, root.id, token, {
      reason: 'SPAM',
      status: 'RESOLVED',
    }).expect(400);
    await list('?status=BAD').expect(400);
    await list('?page=0').expect(400);
    const row = await createReport(post.id, root.id);
    await expectReview(review(row.id, 'RESOLVED'), 400);
    expect((await reports().findById(row.id))?.status).toBe(
      PostReportStatus.PENDING,
    );
  });

  it('rejects own comments, wrong post association, hidden posts and missing comments', async () => {
    const { post, root } = await fixture();
    await submit(post.id, root.id, authorToken)
      .expect(400)
      .expect(({ body }: { body: { code: string } }) =>
        expect(body.code).toBe('OWN_COMMENT'),
      );
    const otherPost = await createPost(e2e.mongo, { authorId: author.id });
    await submit(otherPost.id, root.id).expect(404);
    await submit(post.id, randomUUID()).expect(404);
    for (const status of [PostStatus.DRAFT, PostStatus.REJECTED]) {
      const hidden = await fixture(status);
      await submit(hidden.post.id, hidden.root.id).expect(404);
    }
  });

  it('returns a private receipt and preserves trimmed details and the original evidence', async () => {
    const { post, root } = await fixture();
    const response = await submit(post.id, root.id).expect(201);
    const body = response.body as Record<string, unknown>;
    expect(body).toMatchObject({
      postId: post.id,
      commentId: root.id,
      status: 'PENDING',
      details: 'Xin admin kiểm tra',
    });
    for (const key of [
      'reporterId',
      'bodySnapshot',
      'authorSnapshot',
      'reviewedById',
    ])
      expect(body).not.toHaveProperty(key);
    const stored = await reports().findById(body.id);
    expect(stored?.bodySnapshot).toBe(root.body);
    expect(stored?.authorSnapshot.id).toBe(author.id);
    expect((await comments().findById(root.id))?.updatedAt.getTime()).toBe(
      root.updatedAt.getTime(),
    );
  });

  it('allows exactly one report per user/comment under simultaneous submissions', async () => {
    const { post, root } = await fixture();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => submit(post.id, root.id)),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([
      201, 409, 409, 409, 409, 409,
    ]);
    expect(
      await reports().countDocuments({
        commentId: root.id,
        reporterId: reporter.id,
      }),
    ).toBe(1);
  });

  it('keeps evidence after edits, supports status filtering and paginates consistently', async () => {
    const { post, root } = await fixture();
    const row = await createReport(post.id, root.id);
    await comments().updateOne(
      { _id: root.id },
      { $set: { body: 'Nội dung đã sửa' } },
    );
    const response = await list('?status=PENDING&limit=50').expect(200);
    const items = (response.body as { items: AdminCommentReportDto[] }).items;
    expect(items.find((r) => r.id === row.id)?.comment).toMatchObject({
      body: root.body,
      currentBody: 'Nội dung đã sửa',
      isAvailable: true,
    });
    const first = await list('?limit=1&page=1').expect(200);
    const second = await list('?limit=1&page=2').expect(200);
    const page1 = first.body as {
      items: AdminCommentReportDto[];
      meta: { totalItems: number; hasNextPage: boolean };
    };
    const page2 = second.body as { items: AdminCommentReportDto[] };
    expect(page1.meta.hasNextPage).toBe(true);
    expect(page1.items[0].id).not.toBe(page2.items[0].id);
  });

  it('dismisses without deleting content and records the reviewer and timestamp', async () => {
    const { post, root } = await fixture();
    const row = await createReport(post.id, root.id);
    const response = await expectReview(review(row.id, 'DISMISS'), 200);
    expect(response.body).toMatchObject({
      status: 'DISMISSED',
      action: 'DISMISSED',
      reviewedById: admin.id,
    });
    expect((response.body as AdminCommentReportDto).reviewedAt).toBeTruthy();
    expect(await comments().exists({ _id: root.id })).not.toBeNull();
    await expectReview(review(row.id), 409);
    await submit(post.id, root.id).expect(409);
  });

  it('removes just the reported reply, clears references and resolves other reports for that reply', async () => {
    const { post, root } = await fixture();
    const child = await comments().create({
      postId: post.id,
      authorId: author.id,
      parentId: root.id,
      replyToId: root.id,
      body: 'Reply',
    });
    const sibling = await comments().create({
      postId: post.id,
      authorId: author.id,
      parentId: root.id,
      replyToId: child.id,
      body: 'Other reply',
    });
    const row = await createReport(post.id, child.id);
    const second = await createReport(post.id, child.id, otherAdminToken);
    await expectReview(review(row.id), 200);
    expect(await comments().exists({ _id: child.id })).toBeNull();
    expect(await comments().exists({ _id: root.id })).not.toBeNull();
    expect((await comments().findById(sibling.id))?.replyToId).toBeNull();
    expect((await reports().findById(second.id))?.status).toBe(
      PostReportStatus.RESOLVED,
    );
    expect((await reports().findById(row.id))?.bodySnapshot).toBe('Reply');
  });

  it('removes a root and all replies/notifications, resolving pending reports across the thread', async () => {
    const { post, root } = await fixture();
    const child = await comments().create({
      postId: post.id,
      authorId: author.id,
      parentId: root.id,
      replyToId: root.id,
      body: 'Reply',
    });
    const row = await createReport(post.id, root.id);
    const childReport = await createReport(post.id, child.id);
    await model<Notification>(Notification.name).create({
      recipientId: reporter.id,
      actorId: author.id,
      postId: post.id,
      commentId: child.id,
      type: NotificationType.COMMENT_REPLY,
    });
    const response = await expectReview(review(row.id), 200);
    expect(response.body).toMatchObject({
      status: 'RESOLVED',
      action: 'REMOVED',
      comment: { isAvailable: false, body: root.body },
    });
    expect(await comments().countDocuments({ postId: post.id })).toBe(0);
    expect(
      await model<Notification>(Notification.name).countDocuments({
        commentId: child.id,
      }),
    ).toBe(0);
    expect((await reports().findById(childReport.id))?.action).toBe('REMOVED');
    expect(await reports().countDocuments({ postId: post.id })).toBe(2);
  });

  it('keeps snapshots after ordinary deletion and can close an already missing target', async () => {
    const { post, root } = await fixture();
    const row = await createReport(post.id, root.id);
    await request(server())
      .delete(`/api/v1/posts/${post.id}/comments/${root.id}`)
      .auth(authorToken, { type: 'bearer' })
      .expect(204);
    expect(await reports().exists({ _id: row.id })).not.toBeNull();
    const response = await expectReview(review(row.id), 200);
    expect(response.body).toMatchObject({
      action: 'ALREADY_REMOVED',
      comment: { body: root.body, isAvailable: false },
    });
  });

  it('keeps reports visible when the post and author no longer exist', async () => {
    const disposable = await createUser(e2e.mongo);
    const post = await createPost(e2e.mongo, { authorId: disposable.id });
    const root = await comments().create({
      postId: post.id,
      authorId: disposable.id,
      body: 'Evidence remains',
    });
    const row = await createReport(post.id, root.id);
    await e2e.mongo.withTransaction((session) =>
      model<User>(User.name)
        .deleteOne({ _id: disposable.id }, { session })
        .exec(),
    );
    const response = await list('?status=PENDING&limit=50').expect(200);
    const report = (
      response.body as { items: AdminCommentReportDto[] }
    ).items.find((r) => r.id === row.id);
    expect(report).toMatchObject({
      postAvailable: false,
      comment: {
        isAvailable: false,
        body: 'Evidence remains',
        author: { id: disposable.id },
      },
    });
    await expectReview(review(row.id), 200);
  });

  it('allows only one concurrent admin decision', async () => {
    const { post, root } = await fixture();
    const row = await createReport(post.id, root.id);
    const responses = await Promise.all([
      review(row.id, 'REMOVE'),
      review(row.id, 'DISMISS', otherAdminToken),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const decided = await reports().findById(row.id);
    expect([admin.id, otherAdmin.id]).toContain(decided?.reviewedById);
    expect(Boolean(await comments().exists({ _id: root.id }))).toBe(
      decided?.status === PostReportStatus.DISMISSED,
    );
  });

  it('rejects suspended reporters and admins demoted after their JWT was issued', async () => {
    const member = await createUser(e2e.mongo, {
      status: AccountStatus.SUSPENDED,
    });
    const { post, root } = await fixture();
    await submit(post.id, root.id, await e2e.sign(member)).expect(401);
    const demoted = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    const jwt = await e2e.sign(demoted);
    await model<User>(User.name).updateOne(
      { _id: demoted.id },
      { $set: { role: UserRole.USER } },
    );
    const row = await createReport(post.id, root.id);
    await expectReview(review(row.id, 'REMOVE', jwt), 403);
  });

  it('rolls back comment removal when updating reports fails', async () => {
    const { post, root } = await fixture();
    const row = await createReport(post.id, root.id);
    const spy = vi.spyOn(reports(), 'updateMany').mockImplementationOnce(() => {
      throw new Error('Injected report write failure');
    });
    try {
      await expectReview(review(row.id), 500);
    } finally {
      spy.mockRestore();
    }
    expect(await comments().exists({ _id: root.id })).not.toBeNull();
    expect((await reports().findById(row.id))?.status).toBe(
      PostReportStatus.PENDING,
    );
    await expectReview(review(row.id), 200);
  });

  it('does not leave orphan reports when reporting races with deletion', async () => {
    const { post, root } = await fixture();
    const [reported, deleted] = await Promise.all([
      submit(post.id, root.id),
      request(server())
        .delete(`/api/v1/posts/${post.id}/comments/${root.id}`)
        .auth(authorToken, { type: 'bearer' }),
    ]);
    expect(deleted.status).toBe(204);
    expect([201, 404]).toContain(reported.status);
    expect(await comments().exists({ _id: root.id })).toBeNull();
    const stored = await reports().findOne({ commentId: root.id });
    expect(stored?.bodySnapshot ?? null).toBe(
      reported.status === 201 ? root.body : null,
    );
  });

  it('returns global per-comment counts across statuses and pages', async () => {
    const { post, root } = await fixture();
    const first = await createReport(post.id, root.id);
    await createReport(post.id, root.id, adminToken);
    await expectReview(review(first.id, 'DISMISS'), 200);
    const snapshot = (await list('?status=PENDING&limit=1&page=1').expect(200))
      .body as { items: AdminCommentReportDto[] };
    const version = snapshot.items[0].comment.currentVersion;
    await createReport(post.id, root.id, otherAdminToken);
    const current = (await list('?status=PENDING&limit=1&page=1').expect(200))
      .body as { items: AdminCommentReportDto[] };
    expect(current.items[0]).toMatchObject({
      commentId: root.id,
      reportCount: 3,
      pendingReportCount: 2,
      resolvedReportCount: 0,
      dismissedReportCount: 1,
    });
    expect(current.items[0].comment.currentVersion).toBe(version);
    const second = (await list('?status=PENDING&limit=1&page=2').expect(200))
      .body as { items: AdminCommentReportDto[] };
    expect(second.items[0]).toMatchObject({
      commentId: root.id,
      reportCount: 3,
      pendingReportCount: 2,
      dismissedReportCount: 1,
    });
    await request(server())
      .post(`/api/v1/admin/comment-reports/${current.items[0].id}/review`)
      .auth(adminToken, { type: 'bearer' })
      .send({ action: 'REMOVE', expectedCommentVersion: version })
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          reportCount: 3,
          pendingReportCount: 0,
          resolvedReportCount: 2,
          dismissedReportCount: 1,
        }),
      );
  });

  it('preserves snapshots from distinct edits and refuses removal based on a stale or missing preview', async () => {
    const { post, root } = await fixture();
    const first = await createReport(post.id, root.id);
    await request(server())
      .patch(`/api/v1/posts/${post.id}/comments/${root.id}`)
      .auth(authorToken, { type: 'bearer' })
      .send({ body: 'Updated comment before second report' })
      .expect(200);
    const next = await createReport(post.id, root.id, adminToken);
    const page = (await list('?limit=50').expect(200)).body as {
      items: AdminCommentReportDto[];
    };
    const old = page.items.find((row) => row.id === first.id)!;
    const latest = page.items.find((row) => row.id === next.id)!;
    expect(old.comment).toMatchObject({
      body: root.body,
      currentBody: 'Updated comment before second report',
      isEdited: true,
    });
    expect(latest.comment).toMatchObject({
      body: 'Updated comment before second report',
      isEdited: false,
    });
    const endpoint = `/api/v1/admin/comment-reports/${first.id}/review`;
    await request(server())
      .post(endpoint)
      .auth(adminToken, { type: 'bearer' })
      .send({ action: 'REMOVE' })
      .expect(400);
    await request(server())
      .patch(`/api/v1/posts/${post.id}/comments/${root.id}`)
      .auth(authorToken, { type: 'bearer' })
      .send({ body: 'Edited again after the admin preview' })
      .expect(200);
    await request(server())
      .post(endpoint)
      .auth(adminToken, { type: 'bearer' })
      .send({
        action: 'REMOVE',
        expectedCommentVersion: old.comment.currentVersion,
      })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'COMMENT_CHANGED' }),
      );
    expect((await comments().findById(root.id))?.body).toBe(
      'Edited again after the admin preview',
    );
    expect(
      await reports().countDocuments({
        commentId: root.id,
        status: PostReportStatus.PENDING,
      }),
    ).toBe(2);
    expect((await reports().findById(first.id))?.bodySnapshot).toBe(root.body);
    await expectReview(review(first.id), 200);
    expect(await comments().findById(root.id)).toBeNull();
  });

  it('handles legacy snapshots and rejects an old version when the comment is deleted after preview', async () => {
    const { post, root } = await fixture();
    const row = await createReport(post.id, root.id);
    await reports().updateOne(
      { _id: row.id },
      { $unset: { commentVersionSnapshot: 1 } },
    );
    const page = (await list('?limit=50').expect(200)).body as {
      items: AdminCommentReportDto[];
    };
    const preview = page.items.find((item) => item.id === row.id)!;
    expect(preview.comment.isEdited).toBe(false);
    await request(server())
      .delete(`/api/v1/posts/${post.id}/comments/${root.id}`)
      .auth(authorToken, { type: 'bearer' })
      .expect(204);
    await request(server())
      .post(`/api/v1/admin/comment-reports/${row.id}/review`)
      .auth(adminToken, { type: 'bearer' })
      .send({
        action: 'REMOVE',
        expectedCommentVersion: preview.comment.currentVersion,
      })
      .expect(409);
    await expectReview(review(row.id), 200);
    expect((await reports().findById(row.id))?.action).toBe('ALREADY_REMOVED');
  });

  it('returns 404 for missing reviews and publishes the API contracts in Swagger', async () => {
    await expectReview(review(randomUUID()), 404);
    const doc = SwaggerModule.createDocument(
      e2e.app,
      new DocumentBuilder().setTitle('Test').addBearerAuth().build(),
    );
    expect(
      doc.paths['/api/v1/posts/{postId}/comments/{commentId}/report']?.post,
    ).toBeTruthy();
    expect(
      doc.paths['/api/v1/admin/comment-reports']?.get?.security,
    ).toBeTruthy();
  });
});
