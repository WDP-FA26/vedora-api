import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ClientSession, Model } from 'mongoose';
import { lockDocument } from '../mongo/document-lock.js';
import { RefreshToken, User } from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { assertAccountActive } from './account-access.js';

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
    @InjectModel(RefreshToken.name)
    private readonly tokens: Model<RefreshToken>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly mongo: MongoService,
    configService: ConfigService,
  ) {
    this.refreshTokenTtl = configService.get<number>(
      'REFRESH_TOKEN_TTL',
      2592000,
    );
  }

  async issue(userId: string): Promise<IssuedRefreshToken> {
    const token = this.generateToken();
    await this.mongo.withTransaction(async (session) => {
      await this.lockActiveAccount(session, userId);
      await this.insertToken(session, randomUUID(), token, userId);
    });

    return { token, expiresIn: this.refreshTokenTtl };
  }

  async rotate(token: string): Promise<RotatedRefreshToken> {
    const tokenHash = this.hashToken(token);
    const storedToken = await this.tokens.findOne({ tokenHash }).exec();

    if (!storedToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const now = new Date();
    if (storedToken.revokedAt) {
      await this.revokeFamily(storedToken.familyId, now);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (storedToken.expiresAt <= now) {
      await this.tokens.updateOne(
        { _id: storedToken.id, revokedAt: null },
        { $set: { revokedAt: now } },
      );
      throw new UnauthorizedException('Refresh token expired');
    }

    const replacementToken = this.generateToken();
    const rotated = await this.mongo.withTransaction(async (session) => {
      await this.lockActiveAccount(session, storedToken.userId);
      const revoked = await this.tokens.updateOne(
        {
          _id: storedToken.id,
          tokenHash,
          revokedAt: null,
          expiresAt: { $gt: now },
        },
        { $set: { revokedAt: now } },
        { session },
      );
      if (revoked.modifiedCount !== 1) return false;

      await this.insertToken(
        session,
        storedToken.familyId,
        replacementToken,
        storedToken.userId,
      );
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
    const storedToken = await this.tokens
      .findOne({ tokenHash: this.hashToken(token) })
      .exec();
    if (!storedToken) return;
    await this.revokeFamily(storedToken.familyId, new Date());
  }

  /** Signs the user out everywhere. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.tokens.updateMany(
      { userId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
  }

  private async revokeFamily(familyId: string, revokedAt: Date): Promise<void> {
    await this.tokens.updateMany(
      { familyId, revokedAt: null },
      { $set: { revokedAt } },
    );
  }

  private generateToken(): string {
    return randomBytes(48).toString('base64url');
  }

  private async insertToken(
    session: ClientSession,
    familyId: string,
    token: string,
    userId: string,
  ): Promise<void> {
    await this.tokens.create(
      [
        {
          _id: randomUUID(),
          familyId,
          tokenHash: this.hashToken(token),
          userId,
          expiresAt: this.expiresAt(),
          revokedAt: null,
        },
      ],
      { session },
    );
  }

  private async lockActiveAccount(
    session: ClientSession,
    userId: string,
  ): Promise<void> {
    await lockDocument(this.mongo, session, 'user', userId);
    const user = await this.users
      .findOne({ _id: userId })
      .select('status')
      .session(session)
      .exec();
    if (!user) throw new UnauthorizedException('Account no longer exists');
    assertAccountActive(user.status);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private expiresAt(): Date {
    return new Date(Date.now() + this.refreshTokenTtl * 1000);
  }
}
