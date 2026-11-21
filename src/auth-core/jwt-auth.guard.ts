import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { isUUID } from 'class-validator';
import type { Model } from 'mongoose';
import { User, WorkspaceMember } from '../mongo/models.js';
import { AuthenticatedRequest, JwtPayload } from './auth.types.js';
import { assertAccountActive } from './account-access.js';
import { extractBearerToken } from './bearer-token.js';
import { assertPageAccess } from './page-access.js';
import { UnauthenticatedException } from '../common/exceptions/unauthenticated.exception.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(WorkspaceMember.name)
    private readonly members: Model<WorkspaceMember>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);

    if (!token) {
      throw new UnauthenticatedException(
        'UNAUTHORIZED',
        'Authentication required',
      );
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      if (
        typeof payload.sub !== 'string' ||
        !isUUID(payload.sub) ||
        typeof payload.username !== 'string' ||
        !payload.username ||
        (payload.act !== undefined &&
          (typeof payload.act !== 'string' || !isUUID(payload.act)))
      ) {
        throw new UnauthenticatedException(
          'UNAUTHORIZED',
          'Invalid access token',
        );
      }
    } catch {
      throw new UnauthenticatedException(
        'UNAUTHORIZED',
        'Invalid or expired access token',
      );
    }

    const user = await this.users
      .findOne({ _id: payload.sub })
      .select('username role status')
      .exec();
    if (!user) {
      throw new UnauthenticatedException(
        'UNAUTHORIZED',
        'Account no longer exists',
      );
    }
    assertAccountActive(user.status);
    const actorId = payload.act ?? null;
    if (actorId !== null)
      await assertPageAccess(this.users, this.members, user.id, actorId);
    request.user = {
      sub: user.id,
      username: user.username,
      role: user.role,
      actorId,
    };
    return true;
  }
}
