import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { isUUID } from 'class-validator';
import type { Model } from 'mongoose';
import { User } from '../mongo/models';
import { AuthenticatedRequest, JwtPayload } from './auth.types';
import { assertAccountActive } from './account-access';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request.headers.authorization);

    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      if (
        typeof payload.sub !== 'string' ||
        !isUUID(payload.sub) ||
        typeof payload.username !== 'string' ||
        !payload.username
      ) {
        throw new UnauthorizedException('Invalid access token');
      }
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    // JWT claims can outlive an account or its permissions. Read the current
    // role every time, and never grant access using a role supplied in a JWT.
    const user = await this.users
      .findOne({ _id: payload.sub })
      .select('username role status')
      .exec();
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    assertAccountActive(user.status);
    request.user = { sub: user.id, username: user.username, role: user.role };
    return true;
  }

  private extractBearerToken(authorization?: string): string | undefined {
    const [type, token] = authorization?.split(' ') ?? [];
    return type?.toLowerCase() === 'bearer' && token ? token : undefined;
  }
}
