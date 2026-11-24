import { randomUUID } from 'node:crypto';
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { catchError, mergeMap } from 'rxjs';
import type { OptionalAuthenticatedRequest } from '../auth-core/auth.types.js';
import { ROLES_KEY } from '../auth-core/roles.decorator.js';
import { toErrorBody } from '../common/exceptions/app-exception.filter.js';
import { UserRole } from '../mongo/models.js';
import { AdminSystemLogsService } from './admin-system-logs.service.js';
import {
  systemLogChanges,
  systemLogScope,
  systemLogTarget,
} from './system-log-policy.js';

@Injectable()
export class AdminSystemLogsInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly logs: AdminSystemLogsService,
  ) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const request = context
      .switchToHttp()
      .getRequest<OptionalAuthenticatedRequest>();
    const actor = request.user;
    if (!actor || actor.role !== UserRole.ADMIN) return next.handle();
    const controller =
      this.reflector.get<string | undefined>(
        PATH_METADATA,
        context.getClass(),
      ) ?? '';
    const handler =
      this.reflector.get<string | undefined>(
        PATH_METADATA,
        context.getHandler(),
      ) ?? '';
    if (typeof controller !== 'string' || typeof handler !== 'string')
      return next.handle();
    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const scope = systemLogScope(
      controller,
      handler,
      request.method,
      roles?.includes(UserRole.ADMIN) ?? false,
    );
    if (!scope) return next.handle();
    const response = context.switchToHttp().getResponse<Response>();
    const requestId = randomUUID();
    response.setHeader('X-Request-ID', requestId);
    const start = performance.now();
    const changes = systemLogChanges(request.body as unknown);
    let recorded = false;
    const record = async (data: unknown, error?: unknown) => {
      if (recorded) return;
      recorded = true;
      const failure = error === undefined ? null : toErrorBody(error);
      await this.logs.append({
        ...scope,
        ...changes,
        requestId,
        actorId: actor.sub,
        actorUsername: actor.username,
        method: request.method,
        targetId: systemLogTarget(request.params, data),
        outcome: failure ? 'FAILURE' : 'SUCCESS',
        httpStatus: failure?.statusCode ?? response.statusCode,
        errorCode: failure?.code ?? null,
        durationMs: Math.max(0, Math.round(performance.now() - start)),
      });
    };
    return next.handle().pipe(
      mergeMap(async (data: unknown) => {
        await record(data);
        return data;
      }),
      catchError(async (error: unknown) => {
        await record(undefined, error);
        throw error;
      }),
    );
  }
}
