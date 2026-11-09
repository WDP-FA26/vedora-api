import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';

export interface AiCostContext {
  turnId: string;
  executionId: string;
  feature: string;
  userId: string | null;
}
export const aiCostContext = new AsyncLocalStorage<AiCostContext>();
export const AI_COST_FEATURES = [
  'MEAL_PLAN_CHAT',
  'BLOG_CHAT',
  'GUEST_CHAT',
  'CONTENT_MODERATION',
  'KNOWLEDGE',
  'POSTS',
  'TRANSCRIPTION',
  'SYSTEM',
] as const;

export function requestCostContext(
  request: Pick<Request, 'path' | 'body'> & { user?: { sub: string } },
): AiCostContext {
  const path = request.path;
  const feature = /\/meal-plan\/chat\/?$/.test(path)
    ? 'MEAL_PLAN_CHAT'
    : /\/blogs\/ai\/chat\/?$/.test(path)
      ? 'BLOG_CHAT'
      : /\/nutrition-chat\/?$/.test(path)
        ? 'GUEST_CHAT'
        : /\/knowledge(?:\/|$)/.test(path)
          ? 'KNOWLEDGE'
          : /\/moderation(?:\/|$)/.test(path)
            ? 'CONTENT_MODERATION'
            : /\/posts(?:\/|$)/.test(path)
              ? 'POSTS'
              : 'SYSTEM';
  const userId = request.user?.sub ?? null;
  const body = request.body as Record<string, unknown> | undefined;
  const messages = Array.isArray(body?.messages)
    ? (body.messages as { role?: unknown; id?: unknown }[])
    : [];
  const id =
    feature === 'MEAL_PLAN_CHAT'
      ? body?.requestId
      : feature === 'BLOG_CHAT'
        ? messages.findLast((m) => m?.role === 'user')?.id
        : undefined;
  const executionId = randomUUID();
  const stableId =
    userId && typeof id === 'string' && id.length <= 200 ? id : executionId;
  const session =
    feature === 'BLOG_CHAT' && typeof body?.id === 'string'
      ? body.id.slice(0, 100)
      : '';
  return {
    userId,
    feature,
    executionId,
    turnId: createHash('sha256')
      .update(JSON.stringify([feature, userId, session, stableId]))
      .digest('hex'),
  };
}

@Injectable()
export class AiCostContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const scope = requestCostContext(
      context.switchToHttp().getRequest<Request & { user?: { sub: string } }>(),
    );
    return new Observable((subscriber) =>
      aiCostContext.run(scope, () => {
        const subscription = next.handle().subscribe(subscriber);
        return () => subscription.unsubscribe();
      }),
    );
  }
}
