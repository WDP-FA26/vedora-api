import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { UserRole } from '../mongo/models.js';
import type { AuthenticatedRequest } from './auth.types.js';

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(request: AuthenticatedRequest): Promise<string> {
    return Promise.resolve(request.user.sub);
  }

  /** Admins are not rate limited; the role comes from the verified access token. */
  protected shouldSkip(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return Promise.resolve(request.user.role === UserRole.ADMIN);
  }
}
