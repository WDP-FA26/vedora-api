import 'reflect-metadata';
import { runtimeConfig } from '@src/config/runtime-config.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateMealPlanChatThreadDto,
  GenerateMealDaysDto,
  MAX_DISHES_PER_SECTION,
  MealPlannerChatDto,
  SaveMealDayDto,
  SaveMealDaysDto,
  UpdateMealPlanChatThreadDto,
  WEEKDAYS,
} from '@src/meal-plan/dto/meal-plan.dto.js';
import {
  RequiredWeekQueryDto,
  WeekQueryDto,
} from '@src/meal-plan/dto/week-start.js';
import { ShoppingListQueryDto } from '@src/meal-plan/dto/shopping-list.dto.js';
import { MealSection, Weekday } from '@src/mongo/models.js';

const uuid1 = 'd1a2d3e4-0000-4000-8000-000000000001';
const uuid2 = 'd1a2d3e4-0000-4000-8000-000000000002';

describe('MealPlan & ShoppingList DTOs', () => {
  describe('ShoppingListQueryDto', () => {
    it('defaults to all 7 weekdays when days is omitted', async () => {
      const dto = plainToInstance(ShoppingListQueryDto, {});
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.days).toEqual(WEEKDAYS);
    });

    it('parses comma-separated days and preserves array input', async () => {
      const csv = plainToInstance(ShoppingListQueryDto, {
        days: ' MON , TUE ',
      });
      expect(await validate(csv)).toHaveLength(0);
      expect(csv.days).toEqual([Weekday.MON, Weekday.TUE]);

      const arr = plainToInstance(ShoppingListQueryDto, {
        days: [Weekday.FRI, Weekday.SUN],
      });
      expect(await validate(arr)).toHaveLength(0);
      expect(arr.days).toEqual([Weekday.FRI, Weekday.SUN]);
    });

    it('rejects empty string, unknown weekday, duplicates, or > 7 items', async () => {
      expect(
        await validate(plainToInstance(ShoppingListQueryDto, { days: '' })),
      ).not.toHaveLength(0);
      expect(
        await validate(plainToInstance(ShoppingListQueryDto, { days: 'mon' })),
      ).not.toHaveLength(0);
      expect(
        await validate(
          plainToInstance(ShoppingListQueryDto, { days: 'MON,MON' }),
        ),
      ).not.toHaveLength(0);
      expect(
        await validate(plainToInstance(ShoppingListQueryDto, { days: [] })),
      ).not.toHaveLength(0);
      expect(
        await validate(
          plainToInstance(ShoppingListQueryDto, {
            days: [...WEEKDAYS, Weekday.MON],
          }),
        ),
      ).not.toHaveLength(0);
    });
  });

  describe('SaveMealDaysDto & SaveMealDayDto', () => {
    const validDay = (day: Weekday = Weekday.MON) => ({
      day,
      breakfast: [uuid1],
      lunch: [],
      dinner: [uuid2],
      others: [],
    });

    it('accepts valid day updates', async () => {
      const dto = plainToInstance(SaveMealDaysDto, {
        weekStart: '2026-11-16',
        days: [validDay(Weekday.MON), validDay(Weekday.TUE)],
      });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.days[0]).toBeInstanceOf(SaveMealDayDto);
    });

    it('rejects empty days, duplicate days, invalid weekday, or > 7 days', async () => {
      expect(
        await validate(
          plainToInstance(SaveMealDaysDto, {
            weekStart: '2026-11-16',
            days: [],
          }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(SaveMealDaysDto, {
            weekStart: '2026-11-16',
            days: [validDay(Weekday.MON), validDay(Weekday.MON)],
          }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(SaveMealDaysDto, {
            weekStart: '2026-11-16',
            days: [{ ...validDay(), day: 'INVALID' }],
          }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(SaveMealDaysDto, {
            weekStart: '2026-11-16',
            days: [...WEEKDAYS, Weekday.MON].map((d) => validDay(d)),
          }),
        ),
      ).not.toHaveLength(0);
    });

    it('rejects duplicate recipe IDs, invalid UUIDs, or > 5 dishes in a section', async () => {
      expect(
        await validate(
          plainToInstance(SaveMealDaysDto, {
            weekStart: '2026-11-16',
            days: [{ ...validDay(), lunch: [uuid1, uuid1] }],
          }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(SaveMealDaysDto, {
            weekStart: '2026-11-16',
            days: [{ ...validDay(), lunch: ['not-a-uuid'] }],
          }),
        ),
      ).not.toHaveLength(0);

      const sevenIds = Array.from(
        { length: MAX_DISHES_PER_SECTION + 1 },
        (_, i) => `d1a2d3e4-0000-4000-8000-00000000001${i}`,
      );
      expect(
        await validate(
          plainToInstance(SaveMealDaysDto, {
            weekStart: '2026-11-16',
            days: [{ ...validDay(), others: sevenIds }],
          }),
        ),
      ).not.toHaveLength(0);
    });
  });

  describe('MealPlannerChatDto', () => {
    it('accepts valid chat messages ending with user and optional requestId and threadId', async () => {
      const dto = plainToInstance(MealPlannerChatDto, {
        weekStart: '2026-11-16',
        threadId: uuid1,
        requestId: 'req-123',
        messages: [
          { role: 'user', text: 'Gợi ý thực đơn' },
          { role: 'assistant', text: 'Đây là gợi ý' },
          { role: 'user', text: 'Đổi bữa tối nhé' },
        ],
      });
      expect(await validate(dto)).toHaveLength(0);

      const invalidThread = plainToInstance(MealPlannerChatDto, {
        weekStart: '2026-11-16',
        threadId: 'not-a-uuid',
        messages: [{ role: 'user', text: 'hi' }],
      });
      expect(await validate(invalidThread)).not.toHaveLength(0);
    });

    it('rejects a conversation ending with an assistant turn', async () => {
      const dto = plainToInstance(MealPlannerChatDto, {
        weekStart: '2026-11-16',
        messages: [
          { role: 'user', text: 'Gợi ý thực đơn' },
          { role: 'assistant', text: 'Đây là gợi ý' },
        ],
      });
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('rejects invalid requestId, empty messages, too many messages, or invalid message fields', async () => {
      expect(
        await validate(
          plainToInstance(MealPlannerChatDto, {
            weekStart: '2026-11-16',
            requestId: '',
            messages: [{ role: 'user', text: 'hi' }],
          }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(MealPlannerChatDto, {
            weekStart: '2026-11-16',
            requestId: 'r'.repeat(101),
            messages: [{ role: 'user', text: 'hi' }],
          }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(MealPlannerChatDto, {
            weekStart: '2026-11-16',
            messages: [],
          }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(MealPlannerChatDto, {
            weekStart: '2026-11-16',
            messages: Array.from(
              { length: runtimeConfig.PLANNER_CHAT_MAX_MESSAGES + 1 },
              () => ({
                role: 'user',
                text: 'hi',
              }),
            ),
          }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(MealPlannerChatDto, {
            weekStart: '2026-11-16',
            messages: [{ role: 'system', text: 'hi' }],
          }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(MealPlannerChatDto, {
            weekStart: '2026-11-16',
            messages: [
              {
                role: 'user',
                text: 'a'.repeat(
                  runtimeConfig.PLANNER_CHAT_MAX_MESSAGE_LENGTH + 1,
                ),
              },
            ],
          }),
        ),
      ).not.toHaveLength(0);
    });
  });

  describe('GenerateMealDaysDto', () => {
    it('accepts candidateIds, avoidIds, and pinned slots with optional recipeIds', async () => {
      const dto = plainToInstance(GenerateMealDaysDto, {
        weekStart: '2026-11-16',
        days: [Weekday.MON, Weekday.WED],
        sections: [MealSection.LUNCH, MealSection.DINNER],
        onlyEmpty: false,
        candidateIds: [uuid1],
        avoidIds: [uuid2],
        pinned: [
          { day: Weekday.WED, section: MealSection.LUNCH, recipeIds: [uuid1] },
        ],
      });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects invalid UUIDs or too many recipeIds in pinned slots', async () => {
      const invalidUuid = plainToInstance(GenerateMealDaysDto, {
        weekStart: '2026-11-16',
        days: [Weekday.MON],
        sections: [MealSection.LUNCH],
        onlyEmpty: false,
        pinned: [
          {
            day: Weekday.MON,
            section: MealSection.LUNCH,
            recipeIds: ['not-a-uuid'],
          },
        ],
      });
      expect(await validate(invalidUuid)).not.toHaveLength(0);

      const tooManyIds = Array.from(
        { length: MAX_DISHES_PER_SECTION + 1 },
        (_, i) => `d1a2d3e4-0000-4000-8000-00000000001${i}`,
      );
      const tooMany = plainToInstance(GenerateMealDaysDto, {
        weekStart: '2026-11-16',
        days: [Weekday.MON],
        sections: [MealSection.LUNCH],
        onlyEmpty: false,
        pinned: [
          {
            day: Weekday.MON,
            section: MealSection.LUNCH,
            recipeIds: tooManyIds,
          },
        ],
      });
      expect(await validate(tooMany)).not.toHaveLength(0);
    });
  });

  describe('weekStart', () => {
    const dayUpdate = {
      day: Weekday.MON,
      breakfast: [],
      lunch: [],
      dinner: [],
      others: [],
    };

    it.each(['2026-11-16', '2026-11-23', '2027-01-04'])(
      'accepts the Monday %s',
      async (weekStart) => {
        const dto = plainToInstance(SaveMealDaysDto, {
          weekStart,
          days: [dayUpdate],
        });
        expect(await validate(dto)).toHaveLength(0);
      },
    );

    it.each([
      ['a Sunday', '2026-11-22'],
      ['a Tuesday', '2026-11-17'],
      ['a date that does not exist', '2026-02-30'],
      ['a date with a time', '2026-11-16T00:00:00Z'],
      ['an unpadded date', '2026-1-5'],
      ['text', 'next week'],
      ['an empty string', ''],
    ])('rejects %s', async (_label, weekStart) => {
      const dto = plainToInstance(SaveMealDaysDto, {
        weekStart,
        days: [dayUpdate],
      });
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('requires it when saving, generating and chatting', async () => {
      const messages = [{ role: 'user', text: 'Xin chào' }];
      expect(
        await validate(plainToInstance(SaveMealDaysDto, { days: [dayUpdate] })),
      ).not.toHaveLength(0);
      expect(
        await validate(
          plainToInstance(GenerateMealDaysDto, {
            days: [Weekday.MON],
            sections: [MealSection.LUNCH],
            onlyEmpty: true,
          }),
        ),
      ).not.toHaveLength(0);
      expect(
        await validate(plainToInstance(MealPlannerChatDto, { messages })),
      ).not.toHaveLength(0);
    });

    it('may be left out when reading, but not when discarding a draft', async () => {
      expect(await validate(plainToInstance(WeekQueryDto, {}))).toHaveLength(0);
      expect(
        await validate(
          plainToInstance(WeekQueryDto, { weekStart: '2026-11-22' }),
        ),
      ).not.toHaveLength(0);
      expect(
        await validate(plainToInstance(RequiredWeekQueryDto, {})),
      ).not.toHaveLength(0);
      expect(
        await validate(
          plainToInstance(RequiredWeekQueryDto, { weekStart: '2026-11-16' }),
        ),
      ).toHaveLength(0);
    });
  });

  describe('CreateMealPlanChatThreadDto & UpdateMealPlanChatThreadDto', () => {
    it('accepts valid create and update payloads', async () => {
      const createDto = plainToInstance(CreateMealPlanChatThreadDto, {
        id: uuid1,
        title: 'Thực đơn chay',
      });
      expect(await validate(createDto)).toHaveLength(0);

      const updateDto = plainToInstance(UpdateMealPlanChatThreadDto, {
        title: 'Thực đơn mới',
        proposalStatuses: { 'call-1': 'saved' },
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            text: 'Xin chào',
            parts: [{ type: 'text', text: 'Xin chào' }],
          },
        ],
      });
      expect(await validate(updateDto)).toHaveLength(0);
    });

    it('rejects invalid create/update chat thread fields', async () => {
      expect(
        await validate(
          plainToInstance(CreateMealPlanChatThreadDto, { id: 'bad-id' }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(UpdateMealPlanChatThreadDto, {
            title: '',
          }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(UpdateMealPlanChatThreadDto, {
            messages: [{ id: 'm1', role: 'system', text: 'bad' }],
          }),
        ),
      ).not.toHaveLength(0);
    });
  });
});
