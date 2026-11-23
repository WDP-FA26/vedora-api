import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { UIMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import { InvalidInputException } from '../../../src/common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../../../src/common/exceptions/resource-not-found.exception.js';
import { MEAL_SECTIONS } from '../../../src/meal-plan/dto/meal-plan.dto.js';
import { MealPlanService } from '../../../src/meal-plan/meal-plan.service.js';
import { MealPlannerChatHistoryService } from '../../../src/meal-plan/meal-planner-chat-history.service.js';
import {
  MealPlanChatMessage,
  MealPlanChatThread,
  MealSection,
  Weekday,
} from '../../../src/mongo/models.js';
import { MongoModule } from '../../../src/mongo/mongo.module.js';
import { MongoService } from '../../../src/mongo/mongo.service.js';
import { DietaryService } from '../../../src/recipes/dietary.service.js';
import { IncompatibilityRulesService } from '../../../src/recipes/incompatibility-rules.service.js';
import {
  createIngredient,
  createRecipe,
  createUser,
} from '../../support/fixtures.js';
import {
  createTestMongoUrl,
  dropTestDatabase,
  prepareTestDatabase,
} from '../../support/mongo-test-db.js';

const USER_A = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const USER_B = '5b2f43f5-f29f-4ee8-9c5b-357fe3224aa3';
const RICE_ID = 'a1a2d3e4-0000-4000-8000-000000000003';
const TOFU_RECIPE = 'd1a2d3e4-0000-4000-8000-000000000001';
const SPINACH_RECIPE = 'd1a2d3e4-0000-4000-8000-000000000002';
const RICE_RECIPE = 'd1a2d3e4-0000-4000-8000-000000000003';
const WEEK = '2026-11-16';
const NEXT_WEEK = '2026-11-23';
// 00:30 on Monday 2026-11-16 in the app time zone, so every day is still editable.
const MONDAY_MORNING = new Date('2026-11-15T17:30:00Z');
// 12:00 on Wednesday 2026-11-18 in the app time zone.
const WEDNESDAY = new Date('2026-11-18T05:00:00Z');

const TITLES: Record<string, string> = {
  [TOFU_RECIPE]: 'Đậu hũ sốt cà',
  [SPINACH_RECIPE]: 'Canh rau bina',
  [RICE_RECIPE]: 'Cơm gạo lứt',
};

const recipeRef = (id: string) => ({ id, title: TITLES[id] ?? id, tag: null });

/**
 * A tool output as the planner saves it: one changed day with all four
 * sections, where only lunch differs.
 */
function lunchChange(
  weekStart: string,
  day: Weekday,
  previous: string[],
  recipes: string[],
  applied = true,
) {
  const sections = MEAL_SECTIONS.map((section) => {
    if (section !== MealSection.LUNCH) {
      return { section, previous: [], recipes: [] };
    }
    return {
      section,
      previous: previous.map(recipeRef),
      recipes: recipes.map(recipeRef),
    };
  });
  return { weekStart, days: [{ day, sections }], problems: [], applied };
}

function toolPart(
  type: string,
  output: unknown,
  state = 'output-available',
): Record<string, unknown> {
  return { type, toolCallId: randomUUID(), state, input: {}, output };
}

const lunchOnly = (day: Weekday, lunch: string[] = []) => ({
  day,
  breakfast: [],
  lunch,
  dinner: [],
  others: [],
});

describe('MealPlannerChatHistoryService', () => {
  let app: INestApplication;
  let mongo: MongoService;
  let service: MealPlannerChatHistoryService;
  let mealPlan: MealPlanService;

  const threads = () =>
    mongo.connection.model<MealPlanChatThread>('MealPlanChatThread');
  const messages = () =>
    mongo.connection.model<MealPlanChatMessage>('MealPlanChatMessage');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongoModule.forTest(createTestMongoUrl('meal_plan_chat_history')),
      ],
      providers: [
        MealPlannerChatHistoryService,
        MealPlanService,
        DietaryService,
        IncompatibilityRulesService,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareTestDatabase(app);
    mongo = app.get(MongoService);
    service = app.get(MealPlannerChatHistoryService);
    mealPlan = app.get(MealPlanService);
  });

  beforeEach(async () => {
    for (const collection of [
      'meal_plan_chat_messages',
      'meal_plan_chat_threads',
      'meal_plan_week_entries',
      'recipes',
      'ingredients',
      'users',
    ]) {
      await mongo.connection.collections[collection].deleteMany({});
    }
    await createUser(mongo, { id: USER_A, username: 'chat.user.a' });
    await createUser(mongo, { id: USER_B, username: 'chat.user.b' });
  });

  afterAll(async () => {
    await dropTestDatabase(app);
    await app.close();
  });

  it('creates threads, derives title from first user message, and lists paginated newest first', async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();

    await service.recordUserTurn(
      USER_A,
      firstId,
      [{ role: 'user', text: 'Gợi ý thực đơn chay thanh đạm cho thứ Hai' }],
      'msg-1',
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    await service.recordUserTurn(
      USER_A,
      secondId,
      [{ role: 'user', text: 'B'.repeat(100) }],
      'msg-2',
    );

    const page1 = await service.listThreads(USER_A, { page: 1, limit: 1 });
    expect(page1.meta).toMatchObject({
      page: 1,
      limit: 1,
      totalItems: 2,
      totalPages: 2,
      hasNextPage: true,
      hasPreviousPage: false,
    });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0].id).toBe(secondId);
    expect(page1.items[0].title.length).toBe(80);
    expect(page1.items[0].title.endsWith('…')).toBe(true);

    const page2 = await service.listThreads(USER_A, { page: 2, limit: 1 });
    expect(page2.items[0].id).toBe(firstId);
    expect(page2.items[0].title).toBe(
      'Gợi ý thực đơn chay thanh đạm cho thứ Hai',
    );
  });

  it('saves multi-turn backfill, full assistant tool parts, refused turns, and >10 messages without loss', async () => {
    const threadId = randomUUID();

    await service.recordUserTurn(
      USER_A,
      threadId,
      [
        { role: 'user', text: 'Tin 1' },
        { role: 'assistant', text: 'Đáp 1' },
        { role: 'user', text: 'Lên thực đơn thứ Hai' },
      ],
      'user-turn-2',
    );

    const assistantWithTools: UIMessage = {
      id: 'assistant-turn-2',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        {
          type: 'tool-searchKnowledge',
          toolCallId: 'call-k1',
          state: 'output-available',
          input: { query: 'đạm thực vật' },
          output: {
            status: 'ok',
            hits: [{ title: 'Cẩm nang', page: 3, text: 'Đậu phụ giàu đạm.' }],
          },
        },
        {
          type: 'tool-fillSlots',
          toolCallId: 'call-fill1',
          state: 'output-available',
          input: { days: ['MON'] },
          output: { ok: true, days: [], problems: [] },
        },
        { type: 'text', text: 'Mình đã gợi ý món cho thứ Hai.' },
      ],
    };
    await service.recordAssistantMessage(USER_A, threadId, assistantWithTools);

    // Empty assistant placeholder should not be stored
    await service.recordAssistantMessage(USER_A, threadId, {
      id: 'empty-assistant',
      role: 'assistant',
      parts: [{ type: 'text', text: '   ' }],
    });

    // Refused turn metadata is preserved
    await service.recordUserTurn(
      USER_A,
      threadId,
      [{ role: 'user', text: 'Viết code' }],
      'user-refused',
    );
    await service.recordAssistantMessage(USER_A, threadId, {
      id: 'assistant-refused',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Mình chỉ giúp lên thực đơn.' }],
      metadata: { refused: true },
    });

    // Add 10 more messages so total > 10
    for (let i = 1; i <= 10; i++) {
      await service.recordUserTurn(
        USER_A,
        threadId,
        [{ role: 'user', text: `Câu hỏi thêm ${i}` }],
        `extra-u-${i}`,
      );
    }

    const detail = await service.getThread(USER_A, threadId);
    expect(detail.messageCount).toBe(16);
    expect(detail.messages).toHaveLength(16);
    expect(detail.messages.map((m) => m.id)).toEqual([
      'prior-1',
      'prior-2',
      'user-turn-2',
      'assistant-turn-2',
      'user-refused',
      'assistant-refused',
      ...Array.from({ length: 10 }, (_, idx) => `extra-u-${idx + 1}`),
    ]);
    expect(detail.messages[3].parts).toHaveLength(4);
    expect(detail.messages[5].metadata).toEqual({ refused: true });
  });

  it('updates proposalStatuses, title, and syncs messages idempotently without duplicates', async () => {
    const threadId = randomUUID();
    await service.createThread(USER_A, { id: threadId });

    await service.updateThread(USER_A, threadId, {
      title: 'Thực đơn tuần chay',
      proposalStatuses: { 'call-fill1': 'staged' },
      messages: [
        { id: 'm1', role: 'user', text: 'Gợi ý thực đơn' },
        {
          id: 'm2',
          role: 'assistant',
          text: 'Đây là gợi ý',
          parts: [{ type: 'text', text: 'Đây là gợi ý' }],
        },
      ],
    });

    // Syncing same IDs again updates in place without duplicating
    const updated = await service.updateThread(USER_A, threadId, {
      proposalStatuses: { 'call-fill1': 'saved' },
      messages: [
        { id: 'm1', role: 'user', text: 'Gợi ý thực đơn' },
        {
          id: 'm2',
          role: 'assistant',
          text: 'Đây là gợi ý đã cập nhật',
          parts: [{ type: 'text', text: 'Đây là gợi ý đã cập nhật' }],
        },
      ],
    });

    expect(updated.title).toBe('Thực đơn tuần chay');
    expect(updated.proposalStatuses).toEqual({ 'call-fill1': 'saved' });
    expect(updated.messageCount).toBe(2);
    expect(updated.messages).toHaveLength(2);
    expect(updated.messages[1].text).toBe('Đây là gợi ý đã cập nhật');
  });

  it('rejects invalid proposal statuses and enforces per-user thread isolation', async () => {
    const threadId = randomUUID();
    await service.createThread(USER_A, { id: threadId, title: 'Riêng tư' });

    await expect(
      service.updateThread(USER_A, threadId, {
        // @ts-expect-error testing invalid runtime proposal status
        proposalStatuses: { 'call-1': 'invalid' },
      }),
    ).rejects.toBeInstanceOf(InvalidInputException);

    await expect(
      service.assertThreadAccess(USER_B, threadId),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
    await expect(service.getThread(USER_B, threadId)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
    await expect(
      service.updateThread(USER_B, threadId, { title: 'Hack' }),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
    await expect(service.deleteThread(USER_B, threadId)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it('deletes a thread and cascades removal of all its messages', async () => {
    const threadId = randomUUID();
    await service.recordUserTurn(
      USER_A,
      threadId,
      [{ role: 'user', text: 'Xin chào' }],
      'm-del-1',
    );
    await service.deleteThread(USER_A, threadId);

    await expect(service.getThread(USER_A, threadId)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
    expect(await threads().countDocuments({ _id: threadId })).toBe(0);
    expect(await messages().countDocuments({ threadId })).toBe(0);
  });

  it('cascades deletion of chat threads and messages when a user is deleted', async () => {
    const threadA = randomUUID();
    const threadB = randomUUID();
    await service.recordUserTurn(
      USER_A,
      threadA,
      [{ role: 'user', text: 'Tin của A' }],
      'msg-a',
    );
    await service.recordUserTurn(
      USER_B,
      threadB,
      [{ role: 'user', text: 'Tin của B' }],
      'msg-b',
    );

    await mongo.connection.model('User').deleteOne({ _id: USER_A }).exec();

    expect(await threads().countDocuments({ userId: USER_A })).toBe(0);
    expect(await messages().countDocuments({ userId: USER_A })).toBe(0);
    expect(await threads().countDocuments({ userId: USER_B })).toBe(1);
    expect(await messages().countDocuments({ userId: USER_B })).toBe(1);
  });

  describe('rewind', () => {
    const threadId = randomUUID();

    const lunchOf = async (weekStart: string, day: Weekday) => {
      const plan = await mealPlan.find(USER_A, weekStart);
      const found = plan.days.find((item) => item.day === day);
      const lunch = found?.sections.find(
        ({ section }) => section === MealSection.LUNCH,
      );
      return (lunch?.recipes ?? []).map(({ id }) => id);
    };

    const say = (
      id: string,
      role: 'user' | 'assistant',
      parts: Record<string, unknown>[],
    ) => service.upsertMessage(USER_A, threadId, { id, role, parts });

    const text = (value: string) => ({ type: 'text', text: value });

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: MONDAY_MORNING });
      await createIngredient(mongo, { id: RICE_ID, name: 'Gạo lứt' });
      for (const id of [TOFU_RECIPE, SPINACH_RECIPE, RICE_RECIPE]) {
        await createRecipe(mongo, { id, title: TITLES[id] }, [RICE_ID]);
      }
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('restores the earliest previous of each day, from the target message on, and drops those messages', async () => {
      // The plan as the assistant left it after the turns below.
      await mealPlan.apply(USER_A, WEEK, [
        lunchOnly(Weekday.WED, [SPINACH_RECIPE]),
        lunchOnly(Weekday.THU, [RICE_RECIPE]),
        lunchOnly(Weekday.FRI, [RICE_RECIPE]),
      ]);
      await say('u1', 'user', [text('Xin chào')]);
      await say('a1', 'assistant', [text('Chào bạn!')]);
      await say('u2', 'user', [text('Đổi món trưa thứ Tư')]);
      await say('a2', 'assistant', [
        toolPart('tool-searchRecipes', [{ id: RICE_RECIPE }]),
        toolPart(
          'tool-editPlan',
          lunchChange(WEEK, Weekday.WED, [TOFU_RECIPE], [RICE_RECIPE]),
        ),
        toolPart(
          'tool-fillSlots',
          lunchChange(WEEK, Weekday.WED, [RICE_RECIPE], [SPINACH_RECIPE]),
        ),
        toolPart(
          'tool-fillSlots',
          lunchChange(WEEK, Weekday.THU, [], [RICE_RECIPE]),
        ),
        // Not saved: must not be put back.
        toolPart(
          'tool-autoBalancePlan',
          lunchChange(WEEK, Weekday.FRI, [TOFU_RECIPE], [], false),
        ),
        // Still running: must not be put back.
        toolPart(
          'tool-editPlan',
          lunchChange(WEEK, Weekday.FRI, [SPINACH_RECIPE], [RICE_RECIPE]),
          'input-available',
        ),
        // A draft-era output without `applied`.
        toolPart('tool-editPlan', {
          ...lunchChange(WEEK, Weekday.SAT, [TOFU_RECIPE], []),
          applied: undefined,
        }),
        text('Mình đã đổi món.'),
      ]);
      await say('u3', 'user', [text('Kiểm tra dị ứng tuần sau')]);
      await say('a3', 'assistant', [
        toolPart(
          'tool-verifyMealPlanAllergies',
          lunchChange(NEXT_WEEK, Weekday.MON, [TOFU_RECIPE], []),
        ),
      ]);

      const result = await service.rewind(USER_A, threadId, 'u2');

      expect(result).toEqual({
        text: 'Đổi món trưa thứ Tư',
        weeks: [
          {
            weekStart: WEEK,
            restored: [Weekday.WED, Weekday.THU],
            skipped: [],
            droppedDishes: 0,
          },
          {
            weekStart: NEXT_WEEK,
            restored: [Weekday.MON],
            skipped: [],
            droppedDishes: 0,
          },
        ],
      });
      expect(await lunchOf(WEEK, Weekday.WED)).toEqual([TOFU_RECIPE]);
      expect(await lunchOf(WEEK, Weekday.THU)).toEqual([]);
      expect(await lunchOf(WEEK, Weekday.FRI)).toEqual([RICE_RECIPE]);
      expect(await lunchOf(WEEK, Weekday.SAT)).toEqual([]);
      expect(await lunchOf(NEXT_WEEK, Weekday.MON)).toEqual([TOFU_RECIPE]);

      const detail = await service.getThread(USER_A, threadId);
      expect(detail.messages.map(({ id }) => id)).toEqual(['u1', 'a1']);
      expect(detail.messageCount).toBe(2);
      expect(detail.lastMessagePreview).toBe('Chào bạn!');
    });

    it('skips days that have passed, and empties the thread when rewinding its first message', async () => {
      await say('u1', 'user', [text('Lên thực đơn')]);
      await say('a1', 'assistant', [
        toolPart(
          'tool-fillSlots',
          lunchChange(WEEK, Weekday.MON, [], [TOFU_RECIPE]),
        ),
        toolPart(
          'tool-fillSlots',
          lunchChange(WEEK, Weekday.THU, [], [RICE_RECIPE]),
        ),
      ]);
      await mealPlan.apply(USER_A, WEEK, [
        lunchOnly(Weekday.MON, [TOFU_RECIPE]),
        lunchOnly(Weekday.THU, [RICE_RECIPE]),
      ]);
      expect(
        (await service.getThread(USER_A, threadId)).lastMessagePreview,
      ).toBe('Đã cập nhật thực đơn');
      vi.setSystemTime(WEDNESDAY);

      const result = await service.rewind(USER_A, threadId, 'u1');

      expect(result).toEqual({
        text: 'Lên thực đơn',
        weeks: [
          {
            weekStart: WEEK,
            restored: [Weekday.THU],
            skipped: [Weekday.MON],
            droppedDishes: 0,
          },
        ],
      });
      expect(await lunchOf(WEEK, Weekday.MON)).toEqual([TOFU_RECIPE]);
      expect(await lunchOf(WEEK, Weekday.THU)).toEqual([]);
      const detail = await service.getThread(USER_A, threadId);
      expect(detail.messages).toEqual([]);
      expect(detail.messageCount).toBe(0);
      expect(detail.lastMessagePreview).toBeNull();
    });

    it('lets the conversation go on after a rewind', async () => {
      await say('u1', 'user', [text('Câu 1')]);
      await say('a1', 'assistant', [text('Đáp 1')]);
      await service.rewind(USER_A, threadId, 'u1');

      await say('u2', 'user', [text('Câu 1 sửa lại')]);

      const detail = await service.getThread(USER_A, threadId);
      expect(detail.messages.map(({ id }) => id)).toEqual(['u2']);
      expect(detail.messageCount).toBe(1);
    });

    it('returns 404 for an unknown message, an assistant message, or another user', async () => {
      await say('u1', 'user', [text('Lên thực đơn')]);
      await say('a1', 'assistant', [text('Đây là thực đơn')]);

      await expect(
        service.rewind(USER_A, threadId, 'missing'),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
      await expect(
        service.rewind(USER_A, threadId, 'a1'),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
      await expect(
        service.rewind(USER_B, threadId, 'u1'),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);

      expect(await messages().countDocuments({ threadId })).toBe(2);
    });
  });
});
