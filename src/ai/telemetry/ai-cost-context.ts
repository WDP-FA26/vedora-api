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
  'RECIPE_DRAFT',
  'MEAL_LOG',
  'TRANSCRIPTION',
  'SYSTEM',
] as const;

type AiCostFeature = (typeof AI_COST_FEATURES)[number];

/** The first route a request path matches names its feature; none is SYSTEM. */
const FEATURE_ROUTES: readonly [RegExp, AiCostFeature][] = [
  [/\/meal-plan\/chat\/?$/, 'MEAL_PLAN_CHAT'],
  [/\/blogs\/ai\/chat\/?$/, 'BLOG_CHAT'],
  [/\/nutrition-chat\/?$/, 'GUEST_CHAT'],
  [/\/knowledge(?:\/|$)/, 'KNOWLEDGE'],
  [/\/moderation(?:\/|$)/, 'CONTENT_MODERATION'],
  [/\/posts(?:\/|$)/, 'POSTS'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function featureOf(path: string): AiCostFeature {
  for (const [pattern, feature] of FEATURE_ROUTES) {
    if (pattern.test(path)) return feature;
  }
  return 'SYSTEM';
}

/** The client's id for this turn, which a retry of the same turn repeats. */
function clientTurnId(
  feature: AiCostFeature,
  body: Record<string, unknown>,
): unknown {
  if (feature === 'MEAL_PLAN_CHAT') return body.requestId;
  if (feature !== 'BLOG_CHAT' || !Array.isArray(body.messages))
    return undefined;
  const messages: unknown[] = body.messages;
  const lastUser = messages.findLast(
    (message) => isRecord(message) && message.role === 'user',
  );
  return isRecord(lastUser) ? lastUser.id : undefined;
}

export function requestCostContext(
  request: Pick<Request, 'path' | 'body'> & { user?: { sub: string } },
): AiCostContext {
  const feature = featureOf(request.path);
  const userId = request.user?.sub ?? null;
  const body: unknown = request.body;
  const fields = isRecord(body) ? body : {};
  const id = clientTurnId(feature, fields);
  const executionId = randomUUID();
  const stableId =
    userId && typeof id === 'string' && id.length <= 200 ? id : executionId;
  const session =
    feature === 'BLOG_CHAT' && typeof fields.id === 'string'
      ? fields.id.slice(0, 100)
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
