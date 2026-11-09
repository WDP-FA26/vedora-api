import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthenticatedRequest } from './auth.types.js';

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(request: AuthenticatedRequest): Promise<string> {
    return Promise.resolve(request.user.sub);
  }
}
