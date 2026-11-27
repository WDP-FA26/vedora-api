import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AccessDeniedException } from '../common/exceptions/access-denied.exception.js';
import type { AuthenticatedRequest } from './auth.types.js';

@Injectable()
export class PersonalSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.user.actorId !== null)
      throw new AccessDeniedException(
        'PAGE_SESSION_NOT_ALLOWED',
        'Switch back to your own account to do this',
      );
    return true;
  }
}
