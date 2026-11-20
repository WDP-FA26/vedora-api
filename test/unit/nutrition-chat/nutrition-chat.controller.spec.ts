import type { UIMessageChunk } from 'ai';
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import type { TurnstileService } from '../../../src/captcha/turnstile.service.js';
import { AccessDeniedException } from '../../../src/common/exceptions/access-denied.exception.js';
import type { ClientIpService } from '../../../src/nutrition-chat/guest/client-ip.service.js';
import type { GuestQuotaService } from '../../../src/nutrition-chat/guest/guest-quota.service.js';
import {
  GUEST_SESSION_TTL_SEC,
  type GuestSessionService,
} from '../../../src/nutrition-chat/guest/guest-session.service.js';
import { NutritionChatController } from '../../../src/nutrition-chat/nutrition-chat.controller.js';
import type { NutritionChatService } from '../../../src/nutrition-chat/nutrition-chat.service.js';

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

describe('NutritionChatController', () => {
  let chatService: DeepMockProxy<NutritionChatService>;
  let turnstile: DeepMockProxy<TurnstileService>;
  let sessions: DeepMockProxy<GuestSessionService>;
  let quota: DeepMockProxy<GuestQuotaService>;
  let clientIp: DeepMockProxy<ClientIpService>;
  let controller: NutritionChatController;

  beforeEach(() => {
    chatService = mockDeep<NutritionChatService>();
    turnstile = mockDeep<TurnstileService>();
    sessions = mockDeep<GuestSessionService>();
    quota = mockDeep<GuestQuotaService>();
    clientIp = mockDeep<ClientIpService>();
    pipeUIMessageStreamToResponse.mockClear();

    clientIp.of.mockReturnValue('198.51.100.1');
    controller = new NutritionChatController(
      chatService,
      turnstile,
      sessions,
      quota,
      clientIp,
    );
  });

  describe('createGuestSession', () => {
    const req = {} as Request;

    it('rejects with AccessDeniedException when Turnstile verification fails', async () => {
      turnstile.verify.mockResolvedValue(false);

      await expect(
        controller.createGuestSession(req, { turnstileToken: 'bad' }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof AccessDeniedException && err.code === 'FORBIDDEN',
      );
      expect(turnstile.verify).toHaveBeenCalledWith('bad', '198.51.100.1');
      expect(sessions.issue).not.toHaveBeenCalled();
    });

    it('issues a guest token and returns TTL and remaining quota', async () => {
      turnstile.verify.mockResolvedValue(true);
      sessions.issue.mockResolvedValue('guest.jwt.token');
      sessions.verify.mockResolvedValue('guest-uuid');
      quota.remaining.mockReturnValue(5);

      const result = await controller.createGuestSession(req, {
        turnstileToken: 'good',
      });

      expect(result).toEqual({
        token: 'guest.jwt.token',
        expiresIn: GUEST_SESSION_TTL_SEC,
        remaining: 5,
      });
      expect(quota.remaining).toHaveBeenCalledWith(
        'guest-uuid',
        '198.51.100.1',
      );
    });

    it('returns remaining=0 if verified guestId is unexpectedly null', async () => {
      turnstile.verify.mockResolvedValue(true);
      sessions.issue.mockResolvedValue('guest.jwt.token');
      sessions.verify.mockResolvedValue(null);

      const result = await controller.createGuestSession(req, {
        turnstileToken: 'good',
      });

      expect(result.remaining).toBe(0);
      expect(quota.remaining).not.toHaveBeenCalled();
    });
  });

  describe('chat', () => {
    it('pipes the UI message stream and aborts when the response closes', async () => {
      const fakeStream = new ReadableStream<UIMessageChunk>();
      let capturedSignal: AbortSignal | undefined;
      chatService.stream.mockImplementation((_messages, signal) => {
        capturedSignal = signal;
        return Promise.resolve(fakeStream);
      });

      const responseEmitter = new EventEmitter();
      const response = responseEmitter as unknown as Response;

      await controller.chat(
        { messages: [{ role: 'user', text: 'Đậu phụ có canxi không?' }] },
        response,
      );

      expect(chatService.stream).toHaveBeenCalledWith(
        [{ role: 'user', text: 'Đậu phụ có canxi không?' }],
        expect.any(AbortSignal),
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
});
