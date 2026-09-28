import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthenticatedRequest } from '../auth/auth.types';

/** Limits per signed-in user rather than per IP; runs after `JwtAuthGuard`. */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(request: AuthenticatedRequest): Promise<string> {
    return Promise.resolve(request.user.sub);
  }
}
