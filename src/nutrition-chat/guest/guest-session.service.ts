import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

const AUDIENCE = 'guest';
export const GUEST_SESSION_TTL_SEC = 24 * 60 * 60;

@Injectable()
export class GuestSessionService {
  constructor(private readonly jwtService: JwtService) {}

  issue(): Promise<string> {
    return this.jwtService.signAsync(
      { sub: randomUUID() },
      { audience: AUDIENCE, expiresIn: GUEST_SESSION_TTL_SEC },
    );
  }

  async verify(token: string | undefined): Promise<string | null> {
    if (!token) return null;
    try {
      const { sub } = await this.jwtService.verifyAsync<{ sub?: unknown }>(
        token,
        { audience: AUDIENCE },
      );
      return typeof sub === 'string' ? sub : null;
    } catch {
      return null;
    }
  }
}
