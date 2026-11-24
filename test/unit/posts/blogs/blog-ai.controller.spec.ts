import type { Response } from 'express';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '@src/auth-core/auth.types.js';
import { AiFeature, UserRole } from '@src/mongo/models.js';
import type { BlogAssistantService } from '@src/posts/blogs/ai/blog-assistant.service.js';
import { BlogAiController } from '@src/posts/blogs/blog-ai.controller.js';
import type { BlogAssistantQuotaDto } from '@src/posts/dto/blog-ai.dto.js';

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

describe('BlogAiController', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const authReq = {
    user: { sub: userId, username: 'chef', role: UserRole.USER },
  } as AuthenticatedRequest;

  let assistant: DeepMockProxy<BlogAssistantService>;
  let controller: BlogAiController;

  beforeEach(() => {
    assistant = mockDeep<BlogAssistantService>();
    pipeUIMessageStreamToResponse.mockClear();
    controller = new BlogAiController(assistant);
  });

  it('returns daily/cycle quota for the authenticated user', async () => {
    const quota: BlogAssistantQuotaDto = {
      messages: {
        feature: AiFeature.BLOG_CHAT,
        used: 3,
        limit: 100,
        resetsAt: new Date(),
      },
      images: {
        feature: AiFeature.BLOG_IMAGE,
        used: 1,
        limit: 10,
        resetsAt: new Date(),
      },
    };
    assistant.quota.mockResolvedValue(quota);

    await expect(controller.quota(authReq)).resolves.toBe(quota);
    expect(assistant.quota).toHaveBeenCalledWith(userId);
  });

  it('pipes UI message stream to response and aborts when response closes', async () => {
    const fakeStream = new ReadableStream();
    let capturedSignal: AbortSignal | undefined;
    assistant.stream.mockImplementation((_userId, _dto, signal) => {
      capturedSignal = signal;
      return Promise.resolve(fakeStream as never);
    });

    const closeHandlers: Array<() => void> = [];
    const response = mockDeep<Response>();
    response.on.mockImplementation(
      (event: string | symbol, listener: (...args: never[]) => void) => {
        if (event === 'close') closeHandlers.push(() => listener());
        return response;
      },
    );

    const dto = {
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
      ],
      editor: { title: 'Phở', content: 'Nội dung' },
    };

    await controller.chat(authReq, dto, response);

    expect(assistant.stream).toHaveBeenCalledWith(
      userId,
      dto,
      expect.any(AbortSignal),
    );
    expect(pipeUIMessageStreamToResponse).toHaveBeenCalledWith({
      response,
      stream: fakeStream,
    });
    expect(capturedSignal?.aborted).toBe(false);
    for (const handler of closeHandlers) handler();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
