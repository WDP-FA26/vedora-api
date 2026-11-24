import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { firstValueFrom, Observable, of } from 'rxjs';
import {
  aiCostContext,
  AiCostContextInterceptor,
  requestCostContext,
  type AiCostContext,
} from '@src/ai/telemetry/ai-cost-context.js';

describe('ai-cost-context', () => {
  describe('requestCostContext', () => {
    it.each([
      ['/api/v1/meal-plan/chat', 'MEAL_PLAN_CHAT'],
      ['/api/v1/meal-plan/chat/', 'MEAL_PLAN_CHAT'],
      ['/api/v1/blogs/ai/chat', 'BLOG_CHAT'],
      ['/api/v1/blogs/ai/chat/', 'BLOG_CHAT'],
      ['/api/v1/nutrition-chat', 'GUEST_CHAT'],
      ['/api/v1/nutrition-chat/', 'GUEST_CHAT'],
      ['/api/v1/knowledge', 'KNOWLEDGE'],
      ['/api/v1/knowledge/documents/123', 'KNOWLEDGE'],
      ['/api/v1/moderation/settings', 'CONTENT_MODERATION'],
      ['/api/v1/posts/123', 'POSTS'],
      ['/api/v1/recipes', 'SYSTEM'],
    ])('maps path %s to feature %s', (path, expectedFeature) => {
      const ctx = requestCostContext({ path, body: undefined });
      expect(ctx.feature).toBe(expectedFeature);
      expect(ctx.userId).toBeNull();
      expect(ctx.executionId).toBeTruthy();
      expect(ctx.turnId).toMatch(/^[a-f0-9]{64}$/);
    });

    it('uses body.requestId for authenticated MEAL_PLAN_CHAT turns and isolates invalid or unauthenticated ids', () => {
      const first = requestCostContext({
        path: '/api/v1/meal-plan/chat',
        body: { requestId: 'req-123' },
        user: { sub: 'user-1' },
      });
      const retry = requestCostContext({
        path: '/api/v1/meal-plan/chat',
        body: { requestId: 'req-123' },
        user: { sub: 'user-1' },
      });
      expect(retry.turnId).toBe(first.turnId);
      expect(retry.executionId).not.toBe(first.executionId);

      const tooLong = requestCostContext({
        path: '/api/v1/meal-plan/chat',
        body: { requestId: 'x'.repeat(201) },
        user: { sub: 'user-1' },
      });
      const tooLong2 = requestCostContext({
        path: '/api/v1/meal-plan/chat',
        body: { requestId: 'x'.repeat(201) },
        user: { sub: 'user-1' },
      });
      expect(tooLong.turnId).not.toBe(tooLong2.turnId);

      const unauthenticated = requestCostContext({
        path: '/api/v1/meal-plan/chat',
        body: { requestId: 'req-123' },
      });
      const unauthenticated2 = requestCostContext({
        path: '/api/v1/meal-plan/chat',
        body: { requestId: 'req-123' },
      });
      expect(unauthenticated.turnId).not.toBe(unauthenticated2.turnId);
    });

    it('handles BLOG_CHAT with valid user messages and with missing/non-array messages safely', () => {
      const valid = requestCostContext({
        path: '/api/v1/blogs/ai/chat',
        body: {
          id: 'session-1',
          messages: [
            { id: 'u-1', role: 'user' },
            { id: 'a-1', role: 'assistant' },
          ],
        },
        user: { sub: 'user-1' },
      });
      const continued = requestCostContext({
        path: '/api/v1/blogs/ai/chat',
        body: {
          id: 'session-1',
          messages: [{ id: 'u-1', role: 'user' }],
        },
        user: { sub: 'user-1' },
      });
      expect(valid.turnId).toBe(continued.turnId);

      const ctx = requestCostContext({
        path: '/api/v1/blogs/ai/chat',
        body: { id: 's'.repeat(150), messages: 'not-an-array' },
        user: { sub: 'user-1' },
      });
      expect(ctx.feature).toBe('BLOG_CHAT');
      expect(ctx.userId).toBe('user-1');
    });
  });

  describe('AiCostContextInterceptor', () => {
    const interceptor = new AiCostContextInterceptor();

    it('passes through non-HTTP execution contexts without setting AsyncLocalStorage', async () => {
      let observed: AiCostContext | undefined = {
        turnId: 'sentinel',
        executionId: 'sentinel',
        feature: 'SYSTEM',
        userId: null,
      };
      const context = {
        getType: () => 'rpc',
      } as unknown as ExecutionContext;
      const next: CallHandler = {
        handle: () =>
          new Observable((subscriber) => {
            observed = aiCostContext.getStore();
            subscriber.next('ok');
            subscriber.complete();
          }),
      };

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).resolves.toBe('ok');
      expect(observed).toBeUndefined();
    });

    it('binds requestCostContext for HTTP requests and tears down on unsubscribe', async () => {
      const request = {
        path: '/api/v1/knowledge/documents',
        body: {},
        user: { sub: 'admin-1' },
      } as unknown as Request & { user?: { sub: string } };
      const context = {
        getType: () => 'http',
        switchToHttp: () => ({
          getRequest: () => request,
        }),
      } as unknown as ExecutionContext;

      let insideStore: AiCostContext | undefined;
      const unsubscribed = vi.fn();
      const next: CallHandler = {
        handle: () =>
          new Observable((subscriber) => {
            insideStore = aiCostContext.getStore();
            subscriber.next('done');
            return () => {
              unsubscribed();
            };
          }),
      };

      const sub = interceptor.intercept(context, next).subscribe();
      expect(insideStore).toMatchObject({
        feature: 'KNOWLEDGE',
        userId: 'admin-1',
      });
      sub.unsubscribe();
      expect(unsubscribed).toHaveBeenCalledOnce();
      expect(aiCostContext.getStore()).toBeUndefined();

      const completed = await firstValueFrom(
        interceptor.intercept(context, { handle: () => of('value') }),
      );
      expect(completed).toBe('value');
    });
  });
});
