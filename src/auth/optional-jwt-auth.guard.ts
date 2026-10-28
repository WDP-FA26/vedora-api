import { ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from './jwt-auth.guard.js';

/** Public reads stay anonymous; a supplied token must pass the normal guard. */
@Injectable()
export class OptionalJwtAuthGuard extends JwtAuthGuard {
  canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.headers.authorization === undefined)
      return Promise.resolve(true);
    return super.canActivate(context);
  }
}
