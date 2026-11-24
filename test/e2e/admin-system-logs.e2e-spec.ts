import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { vi } from 'vitest';
import {
  SystemLog,
  User,
  UserAccountAudit,
  UserRole,
  PostComment,
} from '../../src/mongo/models.js';
import { IngredientsService } from '../../src/recipes/ingredients.service.js';
import { createE2eApp, type E2eApp } from '../support/e2e-app.js';
import { createPost, createUser } from '../support/fixtures.js';
import type { SystemLogDto } from '../../src/admin-system-logs/system-log.dto.js';

describe('Administrative system history (real MongoDB HTTP)', () => {
  let e2e: E2eApp;
  let admin: User;
  let member: User;
  let adminToken: string;
  let memberToken: string;
  const logs = () => e2e.connection.model<SystemLog>(SystemLog.name);
  const server = () => e2e.app.getHttpServer();
  const list = (query: object = {}, token = adminToken) =>
    request(server())
      .get('/api/v1/admin/system-logs')
      .auth(token, { type: 'bearer' })
      .query(query);
  const create = (body: object, token = adminToken) =>
    request(server())
      .post('/api/v1/admin/ingredients')
      .auth(token, { type: 'bearer' })
      .send(body);
  const rowFor = async (requestId: string) => {
    const row = await logs().findOne({ requestId }).orFail();
    expect(await logs().countDocuments({ requestId })).toBe(1);
    return row;
  };

  beforeAll(async () => {
    e2e = await createE2eApp('system_logs');
    admin = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    member = await createUser(e2e.mongo);
    [adminToken, memberToken] = await Promise.all([
      e2e.sign(admin),
      e2e.sign(member),
    ]);
  });
  afterAll(async () => {
    if (e2e) await e2e.close();
  });
  afterEach(() => vi.restoreAllMocks());

  it('permits only admins to read history, with no create/update/delete history API', async () => {
    await request(server()).get('/api/v1/admin/system-logs').expect(401);
    await list({}, memberToken).expect(403);
    await request(server())
      .get('/api/v1/admin/system-logs/' + randomUUID())
      .auth(memberToken, { type: 'bearer' })
      .expect(403);
    await list().expect(200);
    for (const method of ['post', 'patch', 'delete'] as const) {
      await request(server())
        [method]('/api/v1/admin/system-logs')
        .auth(adminToken, { type: 'bearer' })
        .send({ outcome: 'SUCCESS' })
        .expect(404);
    }
  });

  it('records create, update and delete once with their original status and target', async () => {
    const created = await create({ name: 'Audit ingredient' }).expect(201);
    const id = (created.body as { id: string }).id;
    expect(await rowFor(created.headers['x-request-id'])).toMatchObject({
      actorId: admin.id,
      actorUsername: admin.username,
      targetId: id,
      outcome: 'SUCCESS',
      httpStatus: 201,
      errorCode: null,
      resourceType: 'INGREDIENT',
      method: 'POST',
      route: '/admin/ingredients',
    });
    const updated = await request(server())
      .put('/api/v1/admin/ingredients/' + id)
      .auth(adminToken, { type: 'bearer' })
      .send({ name: 'Updated ingredient' })
      .expect(200);
    expect(await rowFor(updated.headers['x-request-id'])).toMatchObject({
      targetId: id,
      action: 'PUT /admin/ingredients/:id',
      httpStatus: 200,
    });
    const deleted = await request(server())
      .delete('/api/v1/admin/ingredients/' + id)
      .auth(adminToken, { type: 'bearer' })
      .expect(204);
    expect(await rowFor(deleted.headers['x-request-id'])).toMatchObject({
      targetId: id,
      httpStatus: 204,
      outcome: 'SUCCESS',
    });
  });

  it('records pipe validation failures without storing untrusted paths or arbitrary payloads', async () => {
    const response = await request(server())
      .put('/api/v1/admin/ingredients/secret-path-value')
      .auth(adminToken, { type: 'bearer' })
      .send({ name: '' })
      .expect(400);
    const row = await rowFor(response.headers['x-request-id']);
    expect(row).toMatchObject({
      outcome: 'FAILURE',
      httpStatus: 400,
      errorCode: 'BAD_REQUEST',
      targetId: null,
    });
    expect(JSON.stringify(row)).not.toContain('secret-path-value');
    expect(row.route).toBe('/admin/ingredients/:id');
  });

  it('records missing resources and business conflicts without changing the response', async () => {
    const missingId = randomUUID();
    const missing = await request(server())
      .delete('/api/v1/admin/ingredients/' + missingId)
      .auth(adminToken, { type: 'bearer' })
      .expect(404);
    expect(await rowFor(missing.headers['x-request-id'])).toMatchObject({
      targetId: missingId,
      outcome: 'FAILURE',
      httpStatus: 404,
      errorCode: 'NOT_FOUND',
    });
    const conflict = await request(server())
      .patch('/api/v1/users/' + member.id + '/role')
      .auth(adminToken, { type: 'bearer' })
      .send({
        role: 'ADMIN',
        expectedVersion: 99,
        reason: 'Private reason excluded from HTTP history',
      })
      .expect(409);
    expect(await rowFor(conflict.headers['x-request-id'])).toMatchObject({
      resourceType: 'USER',
      targetRole: 'ADMIN',
      outcome: 'FAILURE',
      httpStatus: 409,
      errorCode: (conflict.body as { code: string }).code,
    });
  });

  it('records unexpected failures with a safe error code, never the error message', async () => {
    vi.spyOn(e2e.app.get(IngredientsService), 'create').mockRejectedValueOnce(
      new Error('private-provider-secret'),
    );
    const failed = await create({ name: 'Should fail' }).expect(500);
    const row = await rowFor(failed.headers['x-request-id']);
    expect(row).toMatchObject({
      outcome: 'FAILURE',
      httpStatus: 500,
      errorCode: 'INTERNAL_ERROR',
    });
    expect(JSON.stringify(row)).not.toContain('private-provider-secret');
  });

  it('keeps credentials, free text, headers and query parameters out of storage and the API', async () => {
    const username = 'created.' + randomUUID().slice(0, 8);
    const forged = randomUUID();
    const response = await request(server())
      .post('/api/v1/users?token=secret-query-value')
      .auth(adminToken, { type: 'bearer' })
      .set('X-Request-ID', forged)
      .set('X-Secret', 'secret-header-value')
      .send({
        username,
        password: 'SecretPassword123!',
        email: username + '@example.test',
        fullName: 'Private Full Name',
      })
      .expect(201);
    const requestId = response.headers['x-request-id'];
    expect(requestId).not.toBe(forged);
    const row = await rowFor(requestId);
    expect(row.targetId).toBe((response.body as { id: string }).id);
    const detail = await request(server())
      .get('/api/v1/admin/system-logs/' + row.id)
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    const json = JSON.stringify({
      stored: row.toObject(),
      exposed: detail.body as unknown,
    });
    for (const secret of [
      'SecretPassword123!',
      username,
      'Private Full Name',
      'secret-query-value',
      'secret-header-value',
      adminToken,
    ])
      expect(json).not.toContain(secret);
  });

  it('preserves transactional account audit and snapshots through renames and actor deletion', async () => {
    const actor = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    const target = await createUser(e2e.mongo);
    const jwt = await e2e.sign(actor);
    const response = await request(server())
      .patch('/api/v1/users/' + target.id + '/status')
      .auth(jwt, { type: 'bearer' })
      .send({
        status: 'SUSPENDED',
        expectedVersion: 0,
        reason: 'Private domain audit reason',
      })
      .expect(200);
    const row = await rowFor(response.headers['x-request-id']);
    expect(row).toMatchObject({
      actorUsername: actor.username,
      targetStatus: 'SUSPENDED',
      httpStatus: 200,
    });
    expect(JSON.stringify(row)).not.toContain('Private domain audit reason');
    expect(
      await e2e.connection
        .model(UserAccountAudit.name)
        .countDocuments({ userId: target.id }),
    ).toBe(1);
    await e2e.connection
      .model(User.name)
      .updateOne({ _id: actor.id }, { $set: { username: 'renamed.admin' } });
    await request(server())
      .delete('/api/v1/users/' + actor.id)
      .auth(adminToken, { type: 'bearer' })
      .expect(204);
    expect(await logs().findById(row.id).orFail()).toMatchObject({
      actorUsername: actor.username,
      actorId: actor.id,
    });
  });

  it('ignores read requests, denied guard requests and ordinary personal actions', async () => {
    const before = await logs().countDocuments();
    await list().expect(200);
    const row = await logs().findOne().orFail();
    await request(server())
      .get('/api/v1/admin/system-logs/' + row.id)
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    await create({ name: 'Guard denied' }, memberToken).expect(403);
    await request(server())
      .patch('/api/v1/users/' + member.id)
      .auth(memberToken, { type: 'bearer' })
      .send({ fullName: 'Changed name' })
      .expect(200);
    const post = await createPost(e2e.mongo, { authorId: member.id });
    await request(server())
      .put('/api/v1/posts/' + post.id + '/like')
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(await logs().countDocuments()).toBe(before);
  });

  it('captures admin comment removal outside the admin URL namespace', async () => {
    const post = await createPost(e2e.mongo, { authorId: member.id });
    const comment = await e2e.connection
      .model<PostComment>(PostComment.name)
      .create({
        postId: post.id,
        authorId: member.id,
        body: 'Remove this comment',
      });
    const response = await request(server())
      .delete(`/api/v1/posts/${post.id}/comments/${comment.id}`)
      .auth(adminToken, { type: 'bearer' })
      .expect(204);
    expect(await rowFor(response.headers['x-request-id'])).toMatchObject({
      targetId: comment.id,
      resourceType: 'COMMENT',
      httpStatus: 204,
    });
  });

  it('paginates on the server with a stable order and supports exact identity/outcome/resource filters', async () => {
    const first = await list({ limit: 2 }).expect(200);
    const next = await list({ limit: 2, page: 2 }).expect(200);
    const a = first.body as {
      items: SystemLogDto[];
      meta: { totalItems: number; hasNextPage: boolean };
    };
    const b = next.body as { items: SystemLogDto[] };
    expect(a.items).toHaveLength(2);
    expect(a.meta.totalItems).toBeGreaterThan(4);
    expect(a.meta.hasNextPage).toBe(true);
    expect(
      a.items.some((row) => b.items.some((other) => other.id === row.id)),
    ).toBe(false);
    const sample = a.items[0];
    const filtered = await list({
      requestId: sample.requestId,
      actorId: sample.actorId,
      targetId: sample.targetId,
      outcome: sample.outcome,
      resourceType: sample.resourceType,
    }).expect(200);
    expect(
      (filtered.body as { items: SystemLogDto[] }).items.map((row) => row.id),
    ).toEqual([sample.id]);
    const none = await list({
      requestId: sample.requestId,
      outcome: sample.outcome === 'SUCCESS' ? 'FAILURE' : 'SUCCESS',
    }).expect(200);
    expect((none.body as { items: unknown[] }).items).toEqual([]);
  });

  it('searches all matching history with escaped regex and inclusive timezone-aware dates', async () => {
    const row = await logs().findOne({ actorId: admin.id }).orFail();
    const found = await list({
      q: row.requestId,
      from: row.createdAt.toISOString(),
      to: row.createdAt.toISOString(),
    }).expect(200);
    expect(
      (found.body as { items: SystemLogDto[] }).items.map((r) => r.id),
    ).toEqual([row.id]);
    const literal = await list({ q: '.*' }).expect(200);
    expect((literal.body as { items: unknown[] }).items).toEqual([]);
    const outside = await list({ to: '2000-01-01T00:00:00+07:00' }).expect(200);
    expect((outside.body as { items: unknown[] }).items).toEqual([]);
  });

  it.each([
    { outcome: 'INVALID' },
    { resourceType: 'invalid' },
    { actorId: 'not-uuid' },
    { requestId: 'not-uuid' },
    { targetId: 'not-uuid' },
    { q: 'x'.repeat(101) },
    { page: 0 },
    { limit: 100 },
    { from: '2026-02-30T00:00:00Z' },
    { from: '2026-11-24' },
    { from: '2026-11-24T00:00:00' },
    { from: '2026-11-25T00:00:00Z', to: '2026-11-24T00:00:00Z' },
  ])('rejects invalid query %j', async (query) => {
    await list(query).expect(400);
  });

  it('returns useful missing-detail errors and validates IDs', async () => {
    await request(server())
      .get('/api/v1/admin/system-logs/' + randomUUID())
      .auth(adminToken, { type: 'bearer' })
      .expect(404);
    await request(server())
      .get('/api/v1/admin/system-logs/not-uuid')
      .auth(adminToken, { type: 'bearer' })
      .expect(400);
  });

  it('does not fail an already successful mutation when history storage is unavailable', async () => {
    const count = await logs().countDocuments();
    vi.spyOn(logs(), 'create').mockRejectedValueOnce(
      new Error('storage-private-error'),
    );
    const response = await create({
      name: 'Business succeeds without history storage',
    }).expect(201);
    expect((response.body as { id: string }).id).toBeTruthy();
    expect(await logs().countDocuments()).toBe(count);
  });

  it('preserves the original business failure even when writing its failure log fails', async () => {
    vi.spyOn(logs(), 'create').mockRejectedValueOnce(
      new Error('storage-private-error'),
    );
    const response = await request(server())
      .delete('/api/v1/admin/ingredients/' + randomUUID())
      .auth(adminToken, { type: 'bearer' })
      .expect(404);
    expect((response.body as { code: string }).code).toBe('NOT_FOUND');
  });
});
