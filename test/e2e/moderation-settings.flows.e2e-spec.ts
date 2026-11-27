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

const choice = (key: string): Choice => ({
  key,
  label: `Nhóm ${key}`,
  reasonText: `vi phạm ${key}`,
  description: `Content that is clearly about ${key}.`,
});

describe('Moderation settings flows (e2e)', () => {
  let e2e: E2eApp;
  let adminToken: string;
  let memberToken: string;
  const server = () => e2e.app.getHttpServer();
  const url = '/api/v1/admin/moderation/settings';

  beforeAll(async () => {
    e2e = await createE2eApp('moderation_settings_flows_e2e');
    const admin: User = await createUser(e2e.mongo, { role: UserRole.ADMIN });
    const member: User = await createUser(e2e.mongo);
    [adminToken, memberToken] = await Promise.all([
      e2e.sign(admin),
      e2e.sign(member),
    ]);
  });
  beforeEach(async () => {
    await e2e.connection.collection('moderation_settings').deleteMany({});
    await asAdmin(request(server()).post(`${url}/reset`)).expect(200);
  });
  afterAll(async () => {
    await e2e.close();
  });

  const asAdmin = (req: request.Test) =>
    req.auth(adminToken, { type: 'bearer' });
  const load = async (): Promise<Settings> =>
    (await asAdmin(request(server()).get(url)).expect(200)).body as Settings;
  const editable = (settings: Settings, changes: object = {}) => ({
    instructions: settings.instructions,
    allowDescription: settings.allowDescription,
    choices: settings.choices,
    version: settings.version,
    ...changes,
  });
  const save = (payload: object) =>
    asAdmin(request(server()).put(url)).send(payload);

  describe('concurrent edits', () => {
    it('accepts exactly one of two saves from the same loaded version', async () => {
      const current = await load();

      const responses = await Promise.all([
        save(editable(current, { instructions: `${current.instructions} A.` })),
        save(editable(current, { instructions: `${current.instructions} B.` })),
      ]);

      const statuses = responses.map(({ status }) => status).sort();
      expect(statuses).toEqual([200, 409]);
    });

    it('refuses a save from a version loaded before a reset', async () => {
      const defaults = await load();
      const firstSave = (
        await save(
          editable(defaults, { instructions: `${defaults.instructions} A.` }),
        ).expect(200)
      ).body as Settings;
      const staleEditor = await load();
      await asAdmin(request(server()).post(`${url}/reset`)).expect(200);
      const afterReset = await load();
      const newerPolicy = (
        await save(
          editable(afterReset, {
            choices: [...afterReset.choices, choice('politics')],
          }),
        ).expect(200)
      ).body as Settings;

      const stale = await save(
        editable(staleEditor, {
          instructions: `${staleEditor.instructions} Stale.`,
        }),
      );

      expect(firstSave.version).toBe(1);
      expect(newerPolicy.version).toBeGreaterThan(firstSave.version);
      expect(stale.status).toBe(409);
      expect((await load()).choices.map(({ key }) => key)).toContain(
        'politics',
      );
    });
  });

  describe('validation', () => {
    it.each([
      ['a removed threshold field', { rejectThreshold: 0.9 }],
      [
        'seventeen categories',
        {
          choices: Array.from({ length: 17 }, (_, index) =>
            choice(`group_${index}`),
          ),
        },
      ],
      ['no categories', { choices: [] }],
      ['the reserved allow key', { choices: [choice('allow')] }],
      ['a repeated key', { choices: [choice('spam'), choice('spam')] }],
      ['a key starting with a digit', { choices: [choice('1spam')] }],
      [
        'a label over 40 characters',
        {
          choices: [{ ...choice('spam'), label: 'l'.repeat(41) }],
        },
      ],
      ['instructions under 20 characters', { instructions: 'too short' }],
      ['a negative version', { version: -1 }],
    ])('refuses %s and keeps the policy', async (_name, changes) => {
      const current = await load();

      await save(editable(current, changes)).expect(400);

      expect((await load()).version).toBe(current.version);
    });

    it('accepts sixteen categories', async () => {
      const current = await load();

      await save(
        editable(current, {
          choices: Array.from({ length: 16 }, (_, index) =>
            choice(`group_${index}`),
          ),
        }),
      ).expect(200);
    });

    it('trims text before checking its length', async () => {
      const current = await load();

      await save(
        editable(current, {
          choices: [{ ...choice('spam'), label: `  ${'l'.repeat(40)}  ` }],
        }),
      ).expect(200);
    });

    it('refuses a test text over 5000 characters', async () => {
      await asAdmin(request(server()).post(`${url}/test`))
        .send({ text: 't'.repeat(5001) })
        .expect(400);
    });
  });

  describe('access', () => {
    it('keeps reset and test to admins', async () => {
      await request(server())
        .post(`${url}/reset`)
        .auth(memberToken, { type: 'bearer' })
        .expect(403);
      await request(server())
        .post(`${url}/test`)
        .auth(memberToken, { type: 'bearer' })
        .send({ text: 'x' })
        .expect(403);
      await request(server()).put(url).send({}).expect(401);
    });
  });
});
