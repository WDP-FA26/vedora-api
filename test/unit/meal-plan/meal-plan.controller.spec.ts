import type { UIMessageChunk } from 'ai';
import type { Response } from 'express';
import { EventEmitter } from 'node:events';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '../../../src/auth-core/auth.types.js';
import type { MealPlanDto } from '../../../src/meal-plan/dto/meal-plan.dto.js';
import { MealPlanController } from '../../../src/meal-plan/meal-plan.controller.js';
import type { MealPlanService } from '../../../src/meal-plan/meal-plan.service.js';
import type { MealPlannerChatHistoryService } from '../../../src/meal-plan/meal-planner-chat-history.service.js';
import type { MealPlannerChatService } from '../../../src/meal-plan/meal-planner-chat.service.js';
import { MealSection, UserRole, Weekday } from '../../../src/mongo/models.js';

const { pipeUIMessageStreamToResponse } = vi.hoisted(() => ({
  pipeUIMessageStreamToResponse: vi.fn<() => Promise<void>>(() =>
    Promise.resolve(),
  ),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    pipeUIMessageStreamToResponse,
  };
});

const emptyPlan = (): MealPlanDto => ({
  weekStart: '2026-11-16',
  currentWeekStart: '2026-11-16',
  today: '2026-11-16',
  maxWeekStart: '2026-12-14',
  minWeekStart: '2026-11-16',
  editable: true,
  days: [],
  problems: [],
});

describe('MealPlanController', () => {
  const userId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
  const req = {
    user: { sub: userId, username: 'plan.user', role: UserRole.USER },
  } as AuthenticatedRequest;

  let mealPlan: DeepMockProxy<MealPlanService>;
  let chatService: DeepMockProxy<MealPlannerChatService>;
  let chatHistory: DeepMockProxy<MealPlannerChatHistoryService>;
  let controller: MealPlanController;

  beforeEach(() => {
    mealPlan = mockDeep<MealPlanService>();
    chatService = mockDeep<MealPlannerChatService>();
    chatHistory = mockDeep<MealPlannerChatHistoryService>();
    pipeUIMessageStreamToResponse.mockClear();
    controller = new MealPlanController(mealPlan, chatService, chatHistory);
  });

  it('delegates find to MealPlanService.find for the caller', async () => {
    const plan = { ...emptyPlan() };
    mealPlan.find.mockResolvedValue(plan);

    await expect(
      controller.find(req, { weekStart: '2026-11-23' }),
    ).resolves.toBe(plan);
    expect(mealPlan.find).toHaveBeenCalledWith(userId, '2026-11-23');

    await controller.find(req, {});
    expect(mealPlan.find).toHaveBeenLastCalledWith(userId, undefined);
  });

  it('delegates preview to MealPlanService.preview with dto.days', async () => {
    const days = [
      {
        day: Weekday.MON,
        breakfast: [],
        lunch: [],
        dinner: [],
        others: [],
      },
    ];
    const preview = { weekStart: '2026-11-16', days: [], problems: [] };
    mealPlan.preview.mockResolvedValue(preview);

    await expect(
      controller.preview(req, { weekStart: '2026-11-16', days }),
    ).resolves.toBe(preview);
    expect(mealPlan.preview).toHaveBeenCalledWith(userId, '2026-11-16', days);
  });

  it('delegates apply to MealPlanService.apply with dto.days', async () => {
    const days = [
      {
        day: Weekday.TUE,
        breakfast: [],
        lunch: [],
        dinner: [],
        others: [],
      },
    ];
    const saved = emptyPlan();
    mealPlan.apply.mockResolvedValue(saved);

    await expect(
      controller.apply(req, { weekStart: '2026-11-16', days }),
    ).resolves.toBe(saved);
    expect(mealPlan.apply).toHaveBeenCalledWith(userId, '2026-11-16', days);
  });

  it('delegates generate, draft, and discardDraft to MealPlanService', async () => {
    const generateDto = {
      weekStart: '2026-11-16',
      days: [Weekday.MON],
      sections: [MealSection.LUNCH],
      onlyEmpty: true,
    };
    const preview = { weekStart: '2026-11-16', days: [], problems: [] };
    mealPlan.generate.mockResolvedValue(preview);
    await expect(controller.generate(req, generateDto)).resolves.toBe(preview);
    expect(mealPlan.generate).toHaveBeenCalledWith(userId, generateDto);

    const draft = {
      weekStart: '2026-11-16',
      days: [],
      problems: [],
      ok: false,
    };
    mealPlan.getDraft.mockResolvedValue(draft);
    await expect(
      controller.draft(req, { weekStart: '2026-11-16' }),
    ).resolves.toBe(draft);
    expect(mealPlan.getDraft).toHaveBeenCalledWith(userId, '2026-11-16');

    mealPlan.discardDraft.mockResolvedValue(undefined);
    await expect(
      controller.discardDraft(req, { weekStart: '2026-11-16' }),
    ).resolves.toBeUndefined();
    expect(mealPlan.discardDraft).toHaveBeenCalledWith(userId, '2026-11-16');
  });

  it('delegates copy to MealPlanService.copyWeek, not overwriting by default', async () => {
    const copied = emptyPlan();
    mealPlan.copyWeek.mockResolvedValue(copied);

    await expect(
      controller.copy(req, {
        fromWeekStart: '2026-11-16',
        toWeekStart: '2026-11-23',
      }),
    ).resolves.toBe(copied);
    expect(mealPlan.copyWeek).toHaveBeenCalledWith(
      userId,
      '2026-11-16',
      '2026-11-23',
      false,
    );
  });

  it('streams chat responses and aborts when the HTTP response closes', async () => {
    const fakeStream = new ReadableStream<UIMessageChunk>();
    let capturedSignal: AbortSignal | undefined;
    chatService.stream.mockImplementation((_uid, _msgs, signal) => {
      capturedSignal = signal;
      return Promise.resolve(fakeStream);
    });

    const responseEmitter = new EventEmitter();
    const response = responseEmitter as unknown as Response;
    const messages = [{ role: 'user' as const, text: 'Lên thực đơn tuần' }];

    await controller.chat(
      req,
      {
        weekStart: '2026-11-16',
        messages,
        requestId: 'req-1',
        threadId: 'thread-1',
        allowWebSearch: true,
      },
      response,
    );

    expect(chatService.stream).toHaveBeenCalledWith(
      userId,
      messages,
      expect.any(AbortSignal),
      '2026-11-16',
      'req-1',
      'thread-1',
      { allowWebSearch: true },
    );
    expect(pipeUIMessageStreamToResponse).toHaveBeenCalledWith({
      response,
      stream: fakeStream,
    });
    expect(capturedSignal?.aborted).toBe(false);
    responseEmitter.emit('close');
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('delegates chat thread endpoints to MealPlannerChatHistoryService', async () => {
    const page = {
      items: [],
      meta: {
        page: 1,
        limit: 20,
        totalItems: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    };
    const detail = {
      id: 'thread-1',
      title: 'Thực đơn chay',
      messageCount: 0,
      lastMessagePreview: null,
      lastMessageAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      proposalStatuses: {},
      messages: [],
    };
    chatHistory.listThreads.mockResolvedValue(page);
    chatHistory.createThread.mockResolvedValue(detail);
    chatHistory.getThread.mockResolvedValue(detail);
    chatHistory.updateThread.mockResolvedValue(detail);
    chatHistory.deleteThread.mockResolvedValue(undefined);

    await expect(
      controller.listChatThreads(req, { page: 1, limit: 20 }),
    ).resolves.toBe(page);
    expect(chatHistory.listThreads).toHaveBeenCalledWith(userId, {
      page: 1,
      limit: 20,
    });

    await expect(
      controller.createChatThread(req, { title: 'Thực đơn chay' }),
    ).resolves.toBe(detail);
    expect(chatHistory.createThread).toHaveBeenCalledWith(userId, {
      title: 'Thực đơn chay',
    });

    await expect(controller.getChatThread(req, 'thread-1')).resolves.toBe(
      detail,
    );
    expect(chatHistory.getThread).toHaveBeenCalledWith(userId, 'thread-1');

    await expect(
      controller.updateChatThread(req, 'thread-1', {
        proposalStatuses: { 'call-1': 'saved' },
      }),
    ).resolves.toBe(detail);
    expect(chatHistory.updateThread).toHaveBeenCalledWith(userId, 'thread-1', {
      proposalStatuses: { 'call-1': 'saved' },
    });

    await expect(
      controller.deleteChatThread(req, 'thread-1'),
    ).resolves.toBeUndefined();
    expect(chatHistory.deleteThread).toHaveBeenCalledWith(userId, 'thread-1');
  });
});
