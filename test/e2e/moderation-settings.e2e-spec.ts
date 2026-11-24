import request from 'supertest';
import { type User, UserRole } from '@src/mongo/models.js';
import { createE2eApp, type E2eApp } from '@test/support/e2e-app.js';
import { createUser } from '@test/support/fixtures.js';

interface Choice {
  key: string;
  label: string;
  reasonText: string;
  description: string;
}
interface Settings {
  instructions: string;
  allowDescription: string;
  choices: Choice[];
  version: number;
  isDefault: boolean;
}

const POLITICS: Choice = {
  key: 'politics',
  label: 'Chính trị',
  reasonText: 'nội dung chính trị',
  description: 'Campaigning or partisan political messaging.',
};

describe('Moderation settings (e2e)', () => {
  let e2e: E2eApp;
  let admin: User;
  let member: User;
  let adminToken: string;
  let memberToken: string;
  const server = () => e2e.app.getHttpServer();
  const url = '/api/v1/admin/moderation/settings';

  const asAdmin = (req: request.Test) =>
    req.auth(adminToken, { type: 'bearer' });
  const editable = (settings: Settings, changes: Partial<Settings> = {}) => {
    const { instructions, allowDescription, choices, version } = settings;
    return { instructions, allowDescription, choices, version, ...changes };
  };
  const load = async (): Promise<Settings> =>
    (await asAdmin(request(server()).get(url)).expect(200)).body as Settings;

  beforeAll(async () => {
    e2e = await createE2eApp('moderation_settings_e2e');
    admin = await createUser(e2e.mongo, {
      username: 'vedora.admin',
      role: UserRole.ADMIN,
    });
    member = await createUser(e2e.mongo, { username: 'vedora.chef' });
    [adminToken, memberToken] = await Promise.all([
      e2e.sign(admin),
      e2e.sign(member),
    ]);
  });
  beforeEach(async () => {
    // A reset keeps the row and its version count, so start each test from
    // no saved settings at all; the reset then clears the service cache.
    await e2e.connection.collection('moderation_settings').deleteMany({});
    await asAdmin(request(server()).post(`${url}/reset`)).expect(200);
  });
  afterAll(async () => {
    await e2e.close();
  });

  it('is admin only', async () => {
    await request(server())
      .get(url)
      .auth(memberToken, { type: 'bearer' })
      .expect(403);
    await request(server()).get(url).expect(401);
  });

  it('serves the built-in policy first', async () => {
    const settings = await load();
    expect(settings).toMatchObject({ version: 0, isDefault: true });
    expect(settings.choices.map(({ key }) => key)).toEqual([
      'self_harm',
      'sexual',
      'violence',
      'hate',
      'harassment',
      'profanity',
      'illegal',
      'political',
      'spam',
      'manipulation',
    ]);
  });

  it('applies a new category to content posted afterwards', async () => {
    const current = await load();
    const saved = await asAdmin(request(server()).put(url))
      .send(editable(current, { choices: [...current.choices, POLITICS] }))
      .expect(200);
    expect(saved.body).toMatchObject({ version: 1, isDefault: false });

    const post = await request(server())
      .post('/api/v1/posts')
      .auth(memberToken, { type: 'bearer' })
      .send({ type: 'POST', body: 'Bầu cho ông A CHOICE:politics' })
      .expect(201);
    const id = (post.body as { id: string }).id;
    expect(post.body).toMatchObject({ status: 'PROCESSING' });
    await e2e.settled();
    const settled = await request(server())
      .get(`/api/v1/posts/${id}`)
      .auth(memberToken, { type: 'bearer' })
      .expect(200);
    expect(settled.body).toMatchObject({
      status: 'REJECTED',
      moderationVerdict: 'politics',
      moderationReason: 'nội dung chính trị',
    });

    const comment = await request(server())
      .post(`/api/v1/posts/${id}/comments`)
      .auth(memberToken, { type: 'bearer' })
      .send({ body: 'CHOICE:politics' });
    expect(comment.status).toBe(404);
  });

  it('no longer accepts thresholds', async () => {
    const current = await load();
    await asAdmin(request(server()).put(url))
      .send({ ...editable(current), rejectThreshold: 0.99 })
      .expect(400);
  });

  it('lists every problem with a bad edit and keeps the old policy', async () => {
    const current = await load();
    const response = await asAdmin(request(server()).put(url))
      .send(
        editable(current, {
          choices: [
            { ...POLITICS, key: 'allow' },
            { ...POLITICS, key: 'Bad Key' },
          ],
          instructions: 'too short',
        }),
      )
      .expect(400);
    const body = response.body as {
      code: string;
      details: { messages: string[] };
    };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details.messages.length).toBeGreaterThanOrEqual(3);
    expect((await load()).version).toBe(0);
  });

  it('refuses unknown fields and a save from a stale version', async () => {
    const current = await load();
    await asAdmin(request(server()).put(url))
      .send({ ...editable(current), surprise: true })
      .expect(400);
    await asAdmin(request(server()).put(url))
      .send(editable(current))
      .expect(200);
    await asAdmin(request(server()).put(url))
      .send(editable(current))
      .expect(409);
  });

  it('tries a draft without saving it', async () => {
    const current = await load();
    const result = await asAdmin(request(server()).post(`${url}/test`))
      .send({
        text: 'CHOICE:politics',
        settings: (({ version: _version, ...draft }) => draft)(
          editable(current, { choices: [...current.choices, POLITICS] }),
        ),
      })
      .expect(200);
    expect(result.body).toMatchObject({
      decision: 'reject',
      category: 'politics',
      riskLevel: 3,
    });
    expect((await load()).version).toBe(0);
  });

  it('goes back to the defaults on reset', async () => {
    const current = await load();
    await asAdmin(request(server()).put(url))
      .send(editable(current, { choices: [POLITICS] }))
      .expect(200);
    const reset = await asAdmin(request(server()).post(`${url}/reset`)).expect(
      200,
    );
    expect(reset.body).toMatchObject({ version: 0, isDefault: true });
  });
});
