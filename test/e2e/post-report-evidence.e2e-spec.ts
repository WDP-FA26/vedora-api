import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { vi } from 'vitest';
import {
  PostReportEvidence,
  PostReport,
  PostStatus,
  UserRole,
} from '@src/mongo/models.js';
import { StorageService } from '@src/storage/storage.service.js';
import { PostReportEvidenceService } from '@src/posts/interactions/post-report-evidence.service.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createUser, createPost } from '@test/support/fixtures.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQzXMDAAGVANpsoEDZAAAAAElFTkSuQmCC',
  'base64',
);
describe('Post report images and per-post counts (real MongoDB HTTP)', () => {
  let e2e: E2eApp;
  let authorId: string, memberId: string;
  let adminToken: string,
    memberToken: string,
    authorToken: string,
    otherToken: string;
  const bytes = new Map<string, Uint8Array>();
  const storage = {
    isConfigured: () => false,
    putBytes: vi.fn((_target: unknown, key: string, value: Uint8Array) => {
      bytes.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((_target: unknown, key: string) => {
      bytes.delete(key);
      return Promise.resolve();
    }),
    presignDownload: vi.fn((_target: unknown, key: string) =>
      Promise.resolve(
        'https://private.example.test/' + key + '?signed=fixture',
      ),
    ),
  };
  const http = () => request(e2e.app.getHttpServer());
  const upload = (
    postId: string,
    token = memberToken,
    image = PNG,
    contentType = 'image/png',
  ) =>
    http()
      .post(`/api/v1/posts/${postId}/report/evidence`)
      .auth(token, { type: 'bearer' })
      .attach('file', image, { filename: 'evidence.png', contentType });
  const report = (
    postId: string,
    token = memberToken,
    evidenceIds?: string[],
  ) =>
    http()
      .post(`/api/v1/posts/${postId}/report`)
      .auth(token, { type: 'bearer' })
      .send({
        reason: 'SPAM',
        details: 'Private report text',
        ...(evidenceIds ? { evidenceIds } : {}),
      });
  const list = (query: object = {}, token = adminToken) =>
    http()
      .get('/api/v1/admin/reports')
      .auth(token, { type: 'bearer' })
      .query(query);
  const fixture = () => createPost(e2e.mongo, { authorId });
  const evidence = () =>
    e2e.connection.model<PostReportEvidence>(PostReportEvidence.name);

  beforeAll(async () => {
    e2e = await createE2eApp('report_evidence', (builder) =>
      builder.overrideProvider(StorageService).useValue(storage),
    );
    const author = await createUser(e2e.mongo);
    const member = await createUser(e2e.mongo);
    const other = await createUser(e2e.mongo);
    const admin = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    authorId = author.id;
    memberId = member.id;
    [authorToken, memberToken, otherToken, adminToken] = await Promise.all(
      [author, member, other, admin].map((u) => e2e.sign(u)),
    );
  });
  afterAll(async () => {
    if (e2e) await e2e.close();
  });

  it('accepts an optional private image, binds it to the report and exposes a signed URL only to admin', async () => {
    const post = await fixture();
    const uploaded = await upload(post.id).expect(201);
    const imageId = (uploaded.body as { id: string }).id;
    const saved = await evidence().findById(imageId).orFail();
    expect(saved).toMatchObject({
      ownerId: memberId,
      postId: post.id,
      reportId: null,
      contentType: 'image/png',
      sizeBytes: PNG.length,
    });
    expect(Buffer.from(bytes.get(saved.storageKey)!)).toEqual(PNG);
    const response = await report(post.id, memberToken, [imageId]).expect(201);
    expect(JSON.stringify(response.body)).not.toContain('private.example.test');
    expect(response.body).not.toHaveProperty('reporterId');
    expect(await evidence().findById(imageId).orFail()).toMatchObject({
      reportId: (response.body as { id: string }).id,
    });
    const admin = await list({ postId: post.id }).expect(200);
    expect((admin.body as { items: unknown[] }).items).toMatchObject([
      {
        reportCount: 1,
        pendingReportCount: 1,
        evidence: [
          {
            id: imageId,
            url: expect.stringContaining('?signed=fixture') as string,
          },
        ],
      },
    ]);
    await list({ postId: post.id }, authorToken).expect(403);
    const publicPost = await http()
      .get('/api/v1/posts/' + post.id)
      .expect(200);
    expect(JSON.stringify(publicPost.body)).not.toContain(
      'Private report text',
    );
    expect(JSON.stringify(publicPost.body)).not.toContain(
      'post-report-evidence',
    );
  });

  it('reports without any image remain valid', async () => {
    const post = await fixture();
    await report(post.id).expect(201);
    const response = await list({ postId: post.id }).expect(200);
    expect(
      (response.body as { items: { evidence: unknown[] }[] }).items[0].evidence,
    ).toEqual([]);
  });

  it('counts distinct reporters across all statuses and pages, and filters a specific post', async () => {
    const post = await fixture();
    const a = await report(post.id).expect(201);
    await report(post.id, otherToken).expect(201);
    await report(post.id, adminToken).expect(201);
    await report(post.id).expect(409);
    await http()
      .post(
        '/api/v1/admin/reports/' + (a.body as { id: string }).id + '/review',
      )
      .auth(adminToken, { type: 'bearer' })
      .send({ status: 'DISMISSED' })
      .expect(200);
    const response = await list({
      postId: post.id,
      status: 'PENDING',
      limit: 1,
      page: 2,
    }).expect(200);
    expect(response.body).toMatchObject({
      items: [{ postId: post.id, reportCount: 3, pendingReportCount: 2 }],
      meta: { totalItems: 2 },
    });
    const reviewed = await list({
      postId: post.id,
      status: 'DISMISSED',
    }).expect(200);
    expect(reviewed.body).toMatchObject({
      items: [{ reportCount: 3, pendingReportCount: 2 }],
    });
    const absent = await list({ postId: randomUUID() }).expect(200);
    expect(absent.body).toMatchObject({ items: [], meta: { totalItems: 0 } });
    await list({ postId: 'invalid' }).expect(400);
  });

  it('rejects another user’s image or an upload belonging to a different post and rolls back the report', async () => {
    const a = await fixture(),
      b = await fixture();
    const image = (await upload(a.id).expect(201)).body as { id: string };
    await report(a.id, otherToken, [image.id]).expect(400);
    await report(b.id, memberToken, [image.id]).expect(400);
    expect(
      await e2e.connection
        .model(PostReport.name)
        .countDocuments({ postId: { $in: [a.id, b.id] } }),
    ).toBe(0);
    expect(await evidence().findById(image.id).orFail()).toMatchObject({
      reportId: null,
    });
    await report(a.id, memberToken, [image.id]).expect(201);
  });

  it('cannot attach a missing or expired upload', async () => {
    const post = await fixture();
    await report(post.id, memberToken, [randomUUID()]).expect(400);
    const image = (await upload(post.id).expect(201)).body as { id: string };
    await e2e.connection
      .db!.collection<{ _id: string; createdAt: Date }>('post_report_evidence')
      .updateOne(
        { _id: image.id },
        { $set: { createdAt: new Date('2000-01-01') } },
      );
    await report(post.id, memberToken, [image.id]).expect(400);
    expect(await evidence().findById(image.id).orFail()).toMatchObject({
      reportId: null,
    });
  });

  it('allows up to three images and never reuses an attachment during a concurrent duplicate report', async () => {
    const post = await fixture();
    const images: string[] = [];
    for (let i = 0; i < 3; i++)
      images.push(
        ((await upload(post.id).expect(201)).body as { id: string }).id,
      );
    const responses = await Promise.all([
      report(post.id, memberToken, images),
      report(post.id, memberToken, images),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const id = (
      responses.find((response) => response.status === 201)!.body as {
        id: string;
      }
    ).id;
    expect(await evidence().countDocuments({ reportId: id })).toBe(3);
  });

  it.each([
    { ids: [randomUUID(), randomUUID(), randomUUID(), randomUUID()] },
    { ids: ['invalid'] },
    { ids: [] },
  ])('validates evidenceIds %j', async ({ ids }) => {
    const post = await fixture();
    await report(post.id, memberToken, ids).expect(ids.length ? 400 : 201);
  });
  it('rejects duplicate evidence IDs', async () => {
    const post = await fixture();
    const id = randomUUID();
    await report(post.id, memberToken, [id, id]).expect(400);
  });
  it('requires authentication and a published post not owned by the reporter', async () => {
    const post = await fixture();
    await http()
      .post(`/api/v1/posts/${post.id}/report/evidence`)
      .attach('file', PNG, 'proof.png')
      .expect(401);
    await upload(post.id, authorToken).expect(400);
    await upload(randomUUID()).expect(404);
    const draft = await createPost(e2e.mongo, {
      authorId,
      status: PostStatus.DRAFT,
    });
    await upload(draft.id).expect(404);
  });
  it('rejects missing files, unsupported types, forged image MIME, multiple files and oversized images', async () => {
    const post = await fixture();
    await http()
      .post(`/api/v1/posts/${post.id}/report/evidence`)
      .auth(memberToken, { type: 'bearer' })
      .expect(400);
    await upload(
      post.id,
      memberToken,
      Buffer.from('<svg/>'),
      'image/svg+xml',
    ).expect(415);
    await upload(
      post.id,
      memberToken,
      Buffer.from('<html>not an image</html>'),
    ).expect(415);
    await upload(post.id, memberToken, Buffer.alloc(5 * 1048576 + 1)).expect(
      413,
    );
    await http()
      .post(`/api/v1/posts/${post.id}/report/evidence`)
      .auth(memberToken, { type: 'bearer' })
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
      .attach('file', PNG, { filename: 'b.png', contentType: 'image/png' })
      .expect(400);
  });
  it('retains count and evidence after admin soft removal resolves all pending reports', async () => {
    const post = await fixture();
    const image = (await upload(post.id).expect(201)).body as { id: string };
    await report(post.id, memberToken, [image.id]).expect(201);
    await report(post.id, otherToken).expect(201);
    await http()
      .delete('/api/v1/admin/posts/' + post.id)
      .auth(adminToken, { type: 'bearer' })
      .expect(204);
    const response = await list({ postId: post.id }).expect(200);
    expect(
      (
        response.body as {
          items: { reportCount: number; pendingReportCount: number }[];
        }
      ).items.every(
        (row) => row.reportCount === 2 && row.pendingReportCount === 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(response.body)).toContain(image.id);
  });
  it('cleans expired unsent files while leaving bound evidence intact', async () => {
    const post = await fixture();
    const image = (await upload(post.id).expect(201)).body as { id: string };
    await e2e.connection
      .db!.collection<{ _id: string; createdAt: Date }>('post_report_evidence')
      .updateOne(
        { _id: image.id },
        { $set: { createdAt: new Date('2000-01-01') } },
      );
    storage.isConfigured = () => true;
    await e2e.app.get(PostReportEvidenceService).purgeUnsent();
    storage.isConfigured = () => false;
    expect(await evidence().findById(image.id)).toBeNull();
    expect(
      await evidence().countDocuments({ reportId: { $ne: null } }),
    ).toBeGreaterThan(0);
  });
});
