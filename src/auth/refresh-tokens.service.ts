import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

export interface IssuedRefreshToken {
  token: string;
  expiresIn: number;
}

export interface RotatedRefreshToken extends IssuedRefreshToken {
  userId: string;
}

@Injectable()
export class RefreshTokensService {
  private readonly refreshTokenTtl: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.refreshTokenTtl = configService.get<number>(
      'REFRESH_TOKEN_TTL',
      2592000,
    );
  }

  async issue(userId: string): Promise<IssuedRefreshToken> {
    const token = this.generateToken();
    await this.prisma.refreshToken.create({
      data: {
        familyId: randomUUID(),
        tokenHash: this.hashToken(token),
        userId,
        expiresAt: this.expiresAt(),
      },
    });

    return { token, expiresIn: this.refreshTokenTtl };
  }

  async rotate(token: string): Promise<RotatedRefreshToken> {
    const tokenHash = this.hashToken(token);
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!storedToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const now = new Date();
    if (storedToken.revokedAt) {
      await this.revokeFamily(storedToken.familyId, now);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (storedToken.expiresAt <= now) {
      await this.prisma.refreshToken.updateMany({
        where: { id: storedToken.id, revokedAt: null },
        data: { revokedAt: now },
      });
      throw new UnauthorizedException('Refresh token expired');
    }

    const replacementToken = this.generateToken();
    const replacementId = randomUUID();
    const rotated = await this.prisma.$transaction(async (transaction) => {
      const revoked = await transaction.refreshToken.updateMany({
        where: {
          id: storedToken.id,
          tokenHash,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: {
          revokedAt: now,
          replacedByTokenId: replacementId,
        },
      });

      if (revoked.count !== 1) return false;

      await transaction.refreshToken.create({
        data: {
          id: replacementId,
          familyId: storedToken.familyId,
          tokenHash: this.hashToken(replacementToken),
          userId: storedToken.userId,
          expiresAt: this.expiresAt(),
        },
      });
      return true;
    });

    if (!rotated) {
      await this.revokeFamily(storedToken.familyId, now);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    return {
      token: replacementToken,
      expiresIn: this.refreshTokenTtl,
      userId: storedToken.userId,
    };
  }

  async revoke(token: string): Promise<void> {
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(token) },
    });
    if (!storedToken) return;
    await this.revokeFamily(storedToken.familyId, new Date());
  }

  private revokeFamily(familyId: string, revokedAt: Date): Promise<unknown> {
    return this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt },
    });
  }

  private generateToken(): string {
    return randomBytes(48).toString('base64url');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private expiresAt(): Date {
    return new Date(Date.now() + this.refreshTokenTtl * 1000);
  }
}
