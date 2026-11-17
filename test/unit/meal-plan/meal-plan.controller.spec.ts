import type { UIMessageChunk } from 'ai';
import type { Response } from 'express';
import { EventEmitter } from 'node:events';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '../../../src/auth-core/auth.types.js';
import { MealPlanController } from '../../../src/meal-plan/meal-plan.controller.js';
import type { MealPlanService } from '../../../src/meal-plan/meal-plan.service.js';
import type { MealPlannerChatService } from '../../../src/meal-plan/meal-planner-chat.service.js';
import { UserRole, Weekday } from '../../../src/mongo/models.js';

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

describe('MealPlanController', () => {
  const userId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
  const req = {
    user: { sub: userId, username: 'plan.user', role: UserRole.USER },
  } as AuthenticatedRequest;

  let mealPlan: DeepMockProxy<MealPlanService>;
  let chatService: DeepMockProxy<MealPlannerChatService>;
  let controller: MealPlanController;

  beforeEach(() => {
    mealPlan = mockDeep<MealPlanService>();
    chatService = mockDeep<MealPlannerChatService>();
    pipeUIMessageStreamToResponse.mockClear();
    controller = new MealPlanController(mealPlan, chatService);
  });

  it('delegates find to MealPlanService.find for the caller', async () => {
    const plan = { days: [], problems: [] };
    mealPlan.find.mockResolvedValue(plan);

    await expect(controller.find(req)).resolves.toBe(plan);
    expect(mealPlan.find).toHaveBeenCalledWith(userId);
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
    const preview = { days: [], problems: [] };
    mealPlan.preview.mockResolvedValue(preview);

    await expect(controller.preview(req, { days })).resolves.toBe(preview);
    expect(mealPlan.preview).toHaveBeenCalledWith(userId, days);
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
    const saved = { days: [], problems: [] };
    mealPlan.apply.mockResolvedValue(saved);

    await expect(controller.apply(req, { days })).resolves.toBe(saved);
    expect(mealPlan.apply).toHaveBeenCalledWith(userId, days);
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

    await controller.chat(req, { messages, requestId: 'req-1' }, response);

    expect(chatService.stream).toHaveBeenCalledWith(
      userId,
      messages,
      expect.any(AbortSignal),
      'req-1',
    );
    expect(pipeUIMessageStreamToResponse).toHaveBeenCalledWith({
      response,
      stream: fakeStream,
    });
    expect(capturedSignal?.aborted).toBe(false);
    responseEmitter.emit('close');
    expect(capturedSignal?.aborted).toBe(true);
  });
});
