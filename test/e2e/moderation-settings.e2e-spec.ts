import request from 'supertest';
import { type User, UserRole } from '../../src/mongo/models.js';
import { createE2eApp, type E2eApp } from '../support/e2e-app.js';
import { createUser } from '../support/fixtures.js';

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
  rejectThreshold: number;
  reviewThreshold: number;
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
    const { instructions, allowDescription, choices } = settings;
    const { rejectThreshold, reviewThreshold, version } = settings;
    return {
      instructions,
      allowDescription,
      choices,
      rejectThreshold,
      reviewThreshold,
      version,
      ...changes,
    };
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
      'illegal',
      'spam',
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
    expect(post.body).toMatchObject({
      status: 'REJECTED',
      moderationVerdict: 'politics',
      moderationReason: 'nội dung chính trị',
    });

    const comment = await request(server())
      .post(`/api/v1/posts/${(post.body as { id: string }).id}/comments`)
      .auth(memberToken, { type: 'bearer' })
      .send({ body: 'CHOICE:politics' });
    expect(comment.status).toBe(404);
  });

  it('applies new thresholds', async () => {
    const current = await load();
    await asAdmin(request(server()).put(url))
      .send(editable(current, { rejectThreshold: 0.99, reviewThreshold: 0.5 }))
      .expect(200);
    const post = await request(server())
      .post('/api/v1/posts')
      .auth(memberToken, { type: 'bearer' })
      .send({ type: 'POST', body: 'CHOICE:violence' })
      .expect(201);
    expect((post.body as { status: string }).status).toBe('PENDING_REVIEW');
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
          reviewThreshold: 0.95,
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
