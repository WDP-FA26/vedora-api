import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedRequest, JwtPayload } from './auth.types';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
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
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, username: true, role: true },
    });
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    request.user = { sub: user.id, username: user.username, role: user.role };
    return true;
  }

  private extractBearerToken(authorization?: string): string | undefined {
    const [type, token] = authorization?.split(' ') ?? [];
    return type?.toLowerCase() === 'bearer' && token ? token : undefined;
  }
}
