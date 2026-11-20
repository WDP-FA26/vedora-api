import { randomUUID } from 'node:crypto';

// ConfigModule reads the environment when AppModule is imported, so the
// header that separates guest IPs must be set before any import runs.
vi.hoisted(() => {
  process.env.CLIENT_IP_HEADER = 'x-test-ip';
});

import { getModelToken } from '@nestjs/ai';
import { simulateReadableStream } from 'ai';
import {
  Experimental_EvaluationMockModelV4,
  MockLanguageModelV4,
} from 'ai/test';
import request from 'supertest';
import { MODERATION_MODEL } from '../../src/ai/guardrails/guardrail.js';
import { type AiRequest, type User, UserRole } from '../../src/mongo/models.js';
import { GuestSessionService } from '../../src/nutrition-chat/guest/guest-session.service.js';
import { nextWeekStart } from '../support/meal-week.js';
import { createE2eApp, type E2eApp } from '../support/e2e-app.js';
import { createUser } from '../support/fixtures.js';

type StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV4['doStream']>
  >['stream'] extends ReadableStream<infer Part>
    ? Part
    : never;

interface ErrorBody {
  code: string;
}

const FLAGGED = 'FLAGGED-BY-MODERATION';
const REPLY = 'Đậu phụ giàu đạm thực vật.';

const usage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
};

const replyChunks: StreamPart[] = [
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: REPLY },
  { type: 'text-end', id: 'text-1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
];

const failingChunks: StreamPart[] = [
  { type: 'text-start', id: 'text-1' },
  { type: 'error', error: new Error('provider exploded') },
];

let nextChunks: StreamPart[] = replyChunks;
let chunkQueue: StreamPart[][] | null = null;
let chunkDelayInMs: number | null = null;

const languageModel = new MockLanguageModelV4({
  doStream: () =>
    Promise.resolve({
      stream: simulateReadableStream({
        initialDelayInMs: null,
        chunkDelayInMs,
        chunks: chunkQueue?.length
          ? (chunkQueue.shift() ?? replyChunks)
          : nextChunks,
      }),
    }),
});

const moderator = new Experimental_EvaluationMockModelV4({
  doEvaluate: ({ state }: { state: unknown }) =>
    Promise.resolve({
      answers: {
        verdict: {
          type: 'choice' as const,
          choice: JSON.stringify(state).includes(FLAGGED) ? 'harmful' : 'allow',
        },
      },
      warnings: [],
    }),
});

const modelCalls = () => languageModel.doStreamCalls.length;

function isTextDelta(value: unknown): value is { type: string; delta: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'text-delta' &&
    'delta' in value &&
    typeof value.delta === 'string'
  );
}

/** Joins the text deltas of an AI SDK UI message stream (SSE) body. */
function replyText(body: string): string {
  let text = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: {')) continue;
    const chunk: unknown = JSON.parse(line.slice('data: '.length));
    if (isTextDelta(chunk)) text += chunk.delta;
  }
  return text;
}

/** The planner chat is about one week, sent as weekStart. */
const NEXT_WEEK = nextWeekStart();

describe('Assistant chat flows (e2e)', () => {
  let e2e: E2eApp;
  let ipCounter = 0;
  const server = () => e2e.app.getHttpServer();
  const requests = () => e2e.mongo.connection.model<AiRequest>('AiRequest');

  beforeAll(async () => {
    e2e = await createE2eApp('assistant_chat_flows_e2e', (builder) =>
      builder
        .overrideProvider(getModelToken())
        .useValue(languageModel)
        .overrideProvider(MODERATION_MODEL)
        .useValue(moderator),
    );
  });

  beforeEach(() => {
    nextChunks = replyChunks;
    chunkQueue = null;
    chunkDelayInMs = null;
  });

  afterAll(async () => {
    await e2e.close();
    delete process.env.CLIENT_IP_HEADER;
  });

  async function signedUser(): Promise<{ user: User; token: string }> {
    const user = await createUser(e2e.mongo);
    return { user, token: await e2e.sign(user) };
  }

  const userTurn = (text: string) => [{ role: 'user', text }];

  describe('meal planner chat', () => {
    const chat = (token: string, body: object) =>
      request(server())
        .post('/api/v1/meal-plan/chat')
        .set('Authorization', `Bearer ${token}`)
        .send({ weekStart: NEXT_WEEK, ...body });

    it('streams the model reply and charges one completed turn', async () => {
      const { user, token } = await signedUser();
      const requestId = randomUUID();
      const response = await chat(token, {
        requestId,
        messages: userTurn('Gợi ý bữa trưa'),
      }).expect(200);
      expect(replyText(response.text)).toBe(REPLY);
      const row = await requests().findOne({ userId: user.id }).exec();
      expect(row).toMatchObject({ status: 'COMPLETED', charged: true });
    });

    it('answers 409 AI_REQUEST_ALREADY_PROCESSED to a replay and does not call the model again', async () => {
      const { token } = await signedUser();
      const body = { requestId: randomUUID(), messages: userTurn('Thực đơn') };
      await chat(token, body).expect(200);
      const callsBefore = modelCalls();
      const response = await chat(token, body).expect(409);
      expect((response.body as ErrorBody).code).toBe(
        'AI_REQUEST_ALREADY_PROCESSED',
      );
      expect(modelCalls()).toBe(callsBefore);
    });

    it('answers 409 IDEMPOTENCY_CONFLICT when a request id is reused for another prompt', async () => {
      const { token } = await signedUser();
      const requestId = randomUUID();
      await chat(token, { requestId, messages: userTurn('Một') }).expect(200);
      const response = await chat(token, {
        requestId,
        messages: userTurn('Hai'),
      }).expect(409);
      expect((response.body as ErrorBody).code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('scopes a request id to its user', async () => {
      const first = await signedUser();
      const second = await signedUser();
      const body = { requestId: 'shared-id', messages: userTurn('Bữa tối') };
      await chat(first.token, body).expect(200);
      await chat(second.token, body).expect(200);
    });

    it('answers 409 AI_REQUEST_IN_PROGRESS to the same request id while the first is streaming', async () => {
      chunkDelayInMs = 150;
      const { token } = await signedUser();
      const body = { requestId: randomUUID(), messages: userTurn('Chậm') };
      const [first, second] = await Promise.all([
        chat(token, body),
        new Promise<request.Response>((resolve, reject) => {
          setTimeout(() => {
            chat(token, body).then(resolve, reject);
          }, 100);
        }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);
      const conflict = first.status === 409 ? first : second;
      expect((conflict.body as ErrorBody).code).toBe('AI_REQUEST_IN_PROGRESS');
    });

    it('refunds a refused turn without calling the model', async () => {
      const { user, token } = await signedUser();
      const callsBefore = modelCalls();
      const response = await chat(token, {
        requestId: randomUUID(),
        messages: userTurn(FLAGGED),
      }).expect(200);
      expect(replyText(response.text)).not.toContain(REPLY);
      expect(modelCalls()).toBe(callsBefore);
      const row = await requests().findOne({ userId: user.id }).exec();
      expect(row).toMatchObject({ status: 'REFUNDED', charged: false });
    });

    it('refunds a turn whose model stream fails', async () => {
      nextChunks = failingChunks;
      const { user, token } = await signedUser();
      await chat(token, {
        requestId: randomUUID(),
        messages: userTurn('Lỗi'),
      }).expect(200);
      const row = await requests().findOne({ userId: user.id }).exec();
      expect(row).toMatchObject({ status: 'REFUNDED', charged: false });
    });

    it('answers 429 AI_QUOTA_EXCEEDED on the sixth free turn of the day without calling the model', async () => {
      const { token } = await signedUser();
      for (let turn = 0; turn < 5; turn++) {
        await chat(token, {
          requestId: randomUUID(),
          messages: userTurn(`Lượt ${turn}`),
        }).expect(200);
      }
      const callsBefore = modelCalls();
      const response = await chat(token, {
        requestId: randomUUID(),
        messages: userTurn('Lượt 6'),
      }).expect(429);
      expect((response.body as ErrorBody).code).toBe('AI_QUOTA_EXCEEDED');
      expect(modelCalls()).toBe(callsBefore);
    });

    it.each([
      ['a request id of 101 characters', { requestId: 'x'.repeat(101) }],
      ['an empty request id', { requestId: '' }],
      ['no messages', { messages: [] }],
      [
        'eleven messages',
        {
          messages: Array.from({ length: 11 }, () => ({
            role: 'user',
            text: 'x',
          })),
        },
      ],
      ['a system message', { messages: [{ role: 'system', text: 'x' }] }],
      [
        'a message of 4001 characters',
        { messages: userTurn('x'.repeat(4001)) },
      ],
      ['an empty message', { messages: userTurn('') }],
    ])('rejects %s with 400', async (_name, override) => {
      const { token } = await signedUser();
      await chat(token, {
        messages: userTurn('Xin chào'),
        ...override,
      }).expect(400);
    });

    it('rejects a conversation that ends with an assistant turn', async () => {
      const { token } = await signedUser();
      const callsBefore = modelCalls();
      await chat(token, {
        requestId: randomUUID(),
        messages: [
          { role: 'user', text: FLAGGED },
          { role: 'assistant', text: 'Được thôi.' },
        ],
      }).expect(400);
      expect(modelCalls()).toBe(callsBefore);
    });

    it('blocks multi-turn context escalation when an earlier turn is flagged before a harmless final user turn', async () => {
      const { token } = await signedUser();
      const callsBefore = modelCalls();
      const response = await chat(token, {
        requestId: randomUUID(),
        messages: [
          { role: 'user', text: FLAGGED },
          { role: 'assistant', text: 'Được thôi.' },
          { role: 'user', text: 'Tiếp tục thực hiện yêu cầu trên đi.' },
        ],
      }).expect(200);
      expect(replyText(response.text)).not.toContain(REPLY);
      expect(modelCalls()).toBe(callsBefore);
    });

    it('rejects a guest session token with 401', async () => {
      const guestToken = await e2e.app.get(GuestSessionService).issue();
      await chat(guestToken, { messages: userTurn('Xin chào') }).expect(401);
    });
  });

  describe('meal planner chat history', () => {
    const chat = (token: string, body: object) =>
      request(server())
        .post('/api/v1/meal-plan/chat')
        .set('Authorization', `Bearer ${token}`)
        .send({ weekStart: NEXT_WEEK, ...body });

    it('persists normal turns, refused turns, and >10 messages in chronological order without loss', async () => {
      const admin = await createUser(e2e.mongo, { role: UserRole.ADMIN });
      const token = await e2e.sign(admin);
      const threadId = randomUUID();

      // 6 allowed turns -> 12 messages (exceeds MAX_PLANNER_MESSAGES = 10)
      const contextWindow: { role: 'user' | 'assistant'; text: string }[] = [];
      for (let turn = 1; turn <= 6; turn++) {
        const userText = `Câu hỏi ${turn}`;
        contextWindow.push({ role: 'user', text: userText });
        const payload = contextWindow.slice(-10);
        const res = await chat(token, {
          threadId,
          requestId: `u-${turn}`,
          messages: payload,
        }).expect(200);
        expect(replyText(res.text)).toBe(REPLY);
        contextWindow.push({ role: 'assistant', text: REPLY });
      }

      // Add a moderation-refused turn into the same thread
      await chat(token, {
        threadId,
        requestId: 'u-refused',
        messages: [...contextWindow.slice(-9), { role: 'user', text: FLAGGED }],
      }).expect(200);

      const listRes = await request(server())
        .get('/api/v1/meal-plan/chat/threads')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const listBody = listRes.body as {
        items: { id: string; title: string; messageCount: number }[];
      };
      expect(listBody.items).toHaveLength(1);
      expect(listBody.items[0]).toMatchObject({
        id: threadId,
        title: 'Câu hỏi 1',
        messageCount: 14,
      });

      const detailRes = await request(server())
        .get(`/api/v1/meal-plan/chat/threads/${threadId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const detail = detailRes.body as {
        id: string;
        messageCount: number;
        proposalStatuses: Record<string, string>;
        messages: {
          id: string;
          role: 'user' | 'assistant';
          text: string;
          metadata: { refused?: boolean } | null;
        }[];
      };
      expect(detail.messageCount).toBe(14);
      expect(detail.messages).toHaveLength(14);
      expect(detail.messages[0]).toMatchObject({
        id: 'u-1',
        role: 'user',
        text: 'Câu hỏi 1',
      });
      expect(detail.messages[12]).toMatchObject({
        id: 'u-refused',
        role: 'user',
        text: FLAGGED,
      });
      expect(detail.messages[13]).toMatchObject({
        role: 'assistant',
        metadata: { refused: true },
      });
    });

    it('updates proposalStatuses, syncs messages idempotently, isolates users, and deletes threads', async () => {
      const owner = await signedUser();
      const other = await signedUser();
      const threadId = randomUUID();

      await request(server())
        .post('/api/v1/meal-plan/chat/threads')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ id: threadId, title: 'Đoạn chat thực đơn' })
        .expect(201);

      const patched = await request(server())
        .patch(`/api/v1/meal-plan/chat/threads/${threadId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          proposalStatuses: { 'call-1': 'saved' },
          messages: [
            { id: 'm1', role: 'user', text: 'Gợi ý món sáng' },
            {
              id: 'm2',
              role: 'assistant',
              text: 'Bún riêu chay nhé',
              parts: [{ type: 'text', text: 'Bún riêu chay nhé' }],
            },
          ],
        })
        .expect(200);
      expect(patched.body).toMatchObject({
        id: threadId,
        title: 'Đoạn chat thực đơn',
        messageCount: 2,
        proposalStatuses: { 'call-1': 'saved' },
      });

      // Cross-user isolation
      await request(server())
        .get(`/api/v1/meal-plan/chat/threads/${threadId}`)
        .set('Authorization', `Bearer ${other.token}`)
        .expect(404);
      await request(server())
        .patch(`/api/v1/meal-plan/chat/threads/${threadId}`)
        .set('Authorization', `Bearer ${other.token}`)
        .send({ title: 'Steal' })
        .expect(404);
      await request(server())
        .delete(`/api/v1/meal-plan/chat/threads/${threadId}`)
        .set('Authorization', `Bearer ${other.token}`)
        .expect(404);

      // Owner cannot stream into another user's thread either
      await chat(other.token, {
        threadId,
        requestId: randomUUID(),
        messages: userTurn('Xin chào'),
      }).expect(404);

      await request(server())
        .delete(`/api/v1/meal-plan/chat/threads/${threadId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);

      await request(server())
        .get(`/api/v1/meal-plan/chat/threads/${threadId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(404);
    });

    it('persists tool-call parts alongside text replies in streamed assistant messages', async () => {
      const { token } = await signedUser();
      const threadId = randomUUID();
      chunkQueue = [
        [
          {
            type: 'tool-call',
            toolCallId: 'call-get-plan-1',
            toolName: 'getPlan',
            input: '{}',
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage,
          },
        ],
        replyChunks,
      ];

      const res = await chat(token, {
        threadId,
        requestId: 'u-tool-1',
        messages: userTurn('Xem thực đơn hiện tại'),
      }).expect(200);
      expect(replyText(res.text)).toBe(REPLY);

      const detailRes = await request(server())
        .get(`/api/v1/meal-plan/chat/threads/${threadId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const detail = detailRes.body as {
        messageCount: number;
        messages: {
          id: string;
          role: 'user' | 'assistant';
          text: string;
          parts: { type: string; toolCallId?: string; state?: string }[];
        }[];
      };
      expect(detail.messageCount).toBe(2);
      expect(detail.messages[0]).toMatchObject({
        id: 'u-tool-1',
        role: 'user',
        text: 'Xem thực đơn hiện tại',
      });
      expect(detail.messages[1].role).toBe('assistant');
      expect(detail.messages[1].text).toBe(REPLY);
      expect(detail.messages[1].parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool-getPlan',
            toolCallId: 'call-get-plan-1',
            state: 'output-available',
          }),
          expect.objectContaining({
            type: 'text',
            text: REPLY,
          }),
        ]),
      );
    });

    it('keeps the user turn and skips empty assistant messages when the model stream fails', async () => {
      nextChunks = failingChunks;
      const { token } = await signedUser();
      const threadId = randomUUID();

      await chat(token, {
        threadId,
        requestId: 'u-fail-1',
        messages: userTurn('Câu hỏi khi lỗi'),
      }).expect(200);

      const detailRes = await request(server())
        .get(`/api/v1/meal-plan/chat/threads/${threadId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const detail = detailRes.body as {
        messageCount: number;
        messages: { id: string; role: string; text: string }[];
      };
      expect(detail.messageCount).toBe(1);
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages[0]).toMatchObject({
        id: 'u-fail-1',
        role: 'user',
        text: 'Câu hỏi khi lỗi',
      });
    });

    it('avoids duplicates when a synced message id overlaps with streaming and bumps thread ordering on new activity', async () => {
      const { token } = await signedUser();
      const threadA = randomUUID();
      const threadB = randomUUID();

      await request(server())
        .patch(`/api/v1/meal-plan/chat/threads/${threadA}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          messages: [{ id: 'u-sync-1', role: 'user', text: 'Tin đồng bộ' }],
        })
        .expect(200);

      await new Promise((resolve) => setTimeout(resolve, 15));
      await chat(token, {
        threadId: threadB,
        requestId: 'u-b-1',
        messages: userTurn('Đoạn chat B'),
      }).expect(200);

      // Stream into threadA with the already-synced requestId: must not duplicate user message
      await new Promise((resolve) => setTimeout(resolve, 15));
      await chat(token, {
        threadId: threadA,
        requestId: 'u-sync-1',
        messages: userTurn('Tin đồng bộ'),
      }).expect(200);

      const detailA = await request(server())
        .get(`/api/v1/meal-plan/chat/threads/${threadA}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const detailABody = detailA.body as {
        messageCount: number;
        messages: { id: string; role: string }[];
      };
      expect(detailABody.messageCount).toBe(2);
      expect(detailABody.messages.map((m) => [m.id, m.role])).toEqual([
        ['u-sync-1', 'user'],
        [expect.any(String), 'assistant'],
      ]);

      const listRes = await request(server())
        .get('/api/v1/meal-plan/chat/threads')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const listBody = listRes.body as { items: { id: string }[] };
      expect(listBody.items.map((item) => item.id)).toEqual([threadA, threadB]);
    });

    it('handles empty list, out-of-range pagination, validation errors, 404s, and 401s on thread endpoints', async () => {
      const { token } = await signedUser();
      const missingId = randomUUID();

      // Empty list for new user & out-of-range page
      const emptyRes = await request(server())
        .get('/api/v1/meal-plan/chat/threads')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(emptyRes.body).toMatchObject({
        items: [],
        meta: { page: 1, totalItems: 0, totalPages: 0 },
      });

      const outOfRange = await request(server())
        .get('/api/v1/meal-plan/chat/threads?page=99&limit=10')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(outOfRange.body).toMatchObject({
        items: [],
        meta: { page: 99, limit: 10, totalItems: 0 },
      });

      // Invalid pagination & invalid UUID params & invalid proposal status
      await request(server())
        .get('/api/v1/meal-plan/chat/threads?page=0')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
      await request(server())
        .get('/api/v1/meal-plan/chat/threads?limit=51')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
      await request(server())
        .get('/api/v1/meal-plan/chat/threads/not-a-uuid')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
      await request(server())
        .patch('/api/v1/meal-plan/chat/threads/not-a-uuid')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Test' })
        .expect(400);
      await request(server())
        .delete('/api/v1/meal-plan/chat/threads/not-a-uuid')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);

      const createdId = randomUUID();
      await request(server())
        .post('/api/v1/meal-plan/chat/threads')
        .set('Authorization', `Bearer ${token}`)
        .send({ id: createdId })
        .expect(201);
      await request(server())
        .patch(`/api/v1/meal-plan/chat/threads/${createdId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ proposalStatuses: { 'call-1': 'invalid' } })
        .expect(400);

      // Non-existent thread UUID returns 404
      await request(server())
        .get(`/api/v1/meal-plan/chat/threads/${missingId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
      await request(server())
        .delete(`/api/v1/meal-plan/chat/threads/${missingId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      // Unauthenticated requests return 401
      await request(server()).get('/api/v1/meal-plan/chat/threads').expect(401);
      await request(server())
        .post('/api/v1/meal-plan/chat/threads')
        .send({})
        .expect(401);
      await request(server())
        .get(`/api/v1/meal-plan/chat/threads/${createdId}`)
        .expect(401);
      await request(server())
        .patch(`/api/v1/meal-plan/chat/threads/${createdId}`)
        .send({ title: 'X' })
        .expect(401);
      await request(server())
        .delete(`/api/v1/meal-plan/chat/threads/${createdId}`)
        .expect(401);
    });
  });

  describe('guest nutrition chat', () => {
    const newIp = () => {
      ipCounter += 1;
      return `198.51.100.${ipCounter}`;
    };
    const guestToken = () => e2e.app.get(GuestSessionService).issue();
    const ask = (token: string, ip: string, body: unknown) =>
      request(server())
        .post('/api/v1/nutrition-chat')
        .set('Authorization', `Bearer ${token}`)
        .set('x-test-ip', ip)
        .send(body as object);

    it('rejects a request without a guest session with 401', async () => {
      await request(server())
        .post('/api/v1/nutrition-chat')
        .set('x-test-ip', newIp())
        .send({ messages: userTurn('Xin chào') })
        .expect(401);
    });

    it('rejects a member access token with 401', async () => {
      const { token } = await signedUser();
      await ask(token, newIp(), { messages: userTurn('Xin chào') }).expect(401);
    });

    it('streams the model reply to a guest', async () => {
      const response = await ask(await guestToken(), newIp(), {
        messages: userTurn('Đậu phụ có gì?'),
      }).expect(200);
      expect(replyText(response.text)).toBe(REPLY);
    });

    it('answers a flagged message with a canned reply without calling the model', async () => {
      const callsBefore = modelCalls();
      const response = await ask(await guestToken(), newIp(), {
        messages: userTurn(FLAGGED),
      }).expect(200);
      expect(replyText(response.text)).not.toContain(REPLY);
      expect(modelCalls()).toBe(callsBefore);
    });

    it('answers 429 GUEST_QUOTA_REACHED on the sixth message of one guest', async () => {
      const token = await guestToken();
      const ip = newIp();
      for (let turn = 0; turn < 5; turn++) {
        await ask(token, ip, { messages: userTurn(`Câu ${turn}`) }).expect(200);
      }
      const response = await ask(token, ip, {
        messages: userTurn('Câu 6'),
      }).expect(429);
      expect((response.body as ErrorBody).code).toBe('GUEST_QUOTA_REACHED');
    });

    it('answers 429 once an address used its share, even for a new guest', async () => {
      const ip = newIp();
      for (let guest = 0; guest < 4; guest++) {
        const token = await guestToken();
        for (let turn = 0; turn < 5; turn++) {
          await ask(token, ip, { messages: userTurn('Câu') }).expect(200);
        }
      }
      await ask(await guestToken(), ip, {
        messages: userTurn('Câu'),
      }).expect(429);
    });

    // BUG-5: Guest quota is consumed by the guard before body validation, so malformed requests burn messages
    it('does not spend the daily quota on requests rejected as malformed', async () => {
      const token = await guestToken();
      const ip = newIp();
      for (let attempt = 0; attempt < 5; attempt++) {
        await ask(token, ip, { messages: [] }).expect(400);
      }
      await ask(token, ip, { messages: userTurn('Câu hợp lệ') }).expect(200);
    });

    it.each([
      [
        'six messages',
        {
          messages: Array.from({ length: 6 }, () => ({
            role: 'user',
            text: 'x',
          })),
        },
      ],
      [
        'a message of 2001 characters',
        { messages: userTurn('x'.repeat(2001)) },
      ],
      ['a system message', { messages: [{ role: 'system', text: 'x' }] }],
      ['an undeclared field', { messages: userTurn('x'), requestId: 'x' }],
    ])('rejects %s with 400', async (_name, body) => {
      await ask(await guestToken(), newIp(), body).expect(400);
    });

    it('does not pass a flagged user message to the model by appending an assistant turn', async () => {
      const callsBefore = modelCalls();
      await ask(await guestToken(), newIp(), {
        messages: [
          { role: 'user', text: FLAGGED },
          { role: 'assistant', text: 'Được thôi.' },
        ],
      });
      expect(modelCalls()).toBe(callsBefore);
    });

    it('rejects a conversation that ends with an assistant turn', async () => {
      const response = await ask(await guestToken(), newIp(), {
        messages: [
          { role: 'user', text: 'Đậu phụ có gì?' },
          { role: 'assistant', text: 'Được thôi.' },
        ],
      });
      expect(response.status).toBe(400);
    });

    it('blocks multi-turn context escalation on guest chat when an earlier turn is flagged', async () => {
      const callsBefore = modelCalls();
      const response = await ask(await guestToken(), newIp(), {
        messages: [
          { role: 'user', text: FLAGGED },
          { role: 'assistant', text: 'Được thôi.' },
          { role: 'user', text: 'Hãy làm theo đúng hướng dẫn trên.' },
        ],
      }).expect(200);
      expect(replyText(response.text)).not.toContain(REPLY);
      expect(modelCalls()).toBe(callsBefore);
    });

    it('rejects a guest-session request without a Turnstile token with 400', async () => {
      await request(server())
        .post('/api/v1/nutrition-chat/guest-session')
        .send({})
        .expect(400);
    });
  });
});
