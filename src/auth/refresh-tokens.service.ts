import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { ClientSession, Model } from 'mongoose';
import { lockDocument } from '../mongo/document-lock.js';
import {
  RefreshToken,
  type RefreshTokenRevocation,
  User,
  WorkspaceMember,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { assertAccountActive } from '../auth-core/account-access.js';
import { UnauthenticatedException } from '../common/exceptions/unauthenticated.exception.js';

export interface IssuedRefreshToken {
  token: string;
  expiresIn: number;
}

export interface RotatedRefreshToken extends IssuedRefreshToken {
  userId: string;
  /** Set when the session acts as the page in `userId`. */
  actorId: string | null;
}

/** Who a session belongs to: a person, or a person acting as a page. */
export interface SessionOwner {
  userId: string;
  actorId: string | null;
}

/**
 * Refresh tokens rotate on every use, and a revoked token sent again normally
 * means it was stolen, so its whole family is revoked. A token rotated less
 * than `REFRESH_TOKEN_REUSE_GRACE_SECONDS` ago is the exception: parallel
 * refreshes and responses lost on the way back to the browser send it again
 * legitimately. It then gets the same replacement the first rotation issued,
 * as long as that replacement has not rotated in turn (only the most recent
 * predecessor qualifies). The replacement is derived from the old token with
 * an HMAC keyed by the server secret, so it can be given out again without
 * storing it, and only someone holding the old token and the key can know it.
 */
@Injectable()
export class RefreshTokensService {
  private readonly logger = new Logger(RefreshTokensService.name);
  private readonly refreshTokenTtl: number;
  private readonly reuseGraceMs: number;
  private successorKey: Buffer | null = null;

  constructor(
    @InjectModel(RefreshToken.name)
    private readonly tokens: Model<RefreshToken>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(WorkspaceMember.name)
    private readonly members: Model<WorkspaceMember>,
    private readonly mongo: MongoService,
    private readonly configService: ConfigService,
  ) {
    this.refreshTokenTtl = configService.get<number>(
      'REFRESH_TOKEN_TTL',
      2592000,
    );
    this.reuseGraceMs =
      configService.get<number>('REFRESH_TOKEN_REUSE_GRACE_SECONDS', 30) * 1000;
  }

  async issue(
    userId: string,
    actorId: string | null = null,
  ): Promise<IssuedRefreshToken> {
    const token = this.generateToken();
    await this.mongo.withTransaction(async (session) => {
      await this.lockActiveAccount(session, userId);
      if (actorId !== null) {
        await this.lockActiveAccount(session, actorId);
        if (!(await this.isMember(session, userId, actorId)))
          throw new UnauthenticatedException(
            'PAGE_ACCESS_REVOKED',
            'You no longer manage this page',
          );
      }
      await this.insertToken(session, randomUUID(), token, {
        userId,
        actorId,
      });
    });

    return { token, expiresIn: this.refreshTokenTtl };
  }

  async rotate(token: string): Promise<RotatedRefreshToken> {
    const tokenHash = this.hashToken(token);
    const storedToken = await this.tokens.findOne({ tokenHash }).exec();

    if (!storedToken) {
      throw new UnauthenticatedException(
        'UNAUTHORIZED',
        'Invalid refresh token',
      );
    }

    if (storedToken.revokedAt) return this.reissue(token, storedToken);

    const now = new Date();
    if (storedToken.expiresAt <= now) {
      await this.tokens.updateOne(
        { _id: storedToken.id, revokedAt: null },
        { $set: { revokedAt: now, revokedReason: 'EXPIRED' } },
      );
      throw new UnauthenticatedException(
        'UNAUTHORIZED',
        'Refresh token expired',
      );
    }

    const replacementToken = this.successorOf(token);
    const rotated = await this.mongo.withTransaction(async (session) => {
      const owner = await this.nextOwner(session, storedToken);
      const revoked = await this.tokens.updateOne(
        {
          _id: storedToken.id,
          tokenHash,
          revokedAt: null,
          expiresAt: { $gt: now },
        },
        { $set: { revokedAt: now, revokedReason: 'ROTATED' } },
        { session },
      );
      if (revoked.modifiedCount !== 1) return null;

      await this.insertToken(
        session,
        storedToken.familyId,
        replacementToken,
        owner,
      );
      return owner;
    });

    // Another request rotated the same token first: answer like it did.
    if (!rotated) {
      const latest = await this.tokens.findOne({ tokenHash }).exec();
      if (!latest?.revokedAt) {
        throw new UnauthenticatedException(
          'UNAUTHORIZED',
          'Invalid refresh token',
        );
      }
      return this.reissue(token, latest);
    }

    return {
      token: replacementToken,
      expiresIn: this.refreshTokenTtl,
      ...rotated,
    };
  }

  /**
   * Who the rotated session belongs to. A page session whose member was
   * removed from the page falls back to the member's own account instead of
   * signing them out; a suspended member is signed out entirely.
   */
  private async nextOwner(
    session: ClientSession,
    storedToken: RefreshToken,
  ): Promise<SessionOwner> {
    const { userId, actorId } = storedToken;
    if (actorId === null) {
      await this.lockActiveAccount(session, userId);
      return { userId, actorId: null };
    }
    await this.lockActiveAccount(session, actorId);
    if (!(await this.isMember(session, userId, actorId)))
      return { userId: actorId, actorId: null };
    await this.lockActiveAccount(session, userId);
    return { userId, actorId };
  }

  private async isMember(
    session: ClientSession,
    pageUserId: string,
    actorId: string,
  ): Promise<boolean> {
    const membership = await this.members
      .exists({ pageUserId, userId: actorId })
      .session(session)
      .exec();
    return membership !== null;
  }

  /**
   * A revoked token was sent again. Within the grace period after its own
   * rotation it gets the replacement that rotation issued; anything else is
   * treated as reuse of a stolen token and ends the whole family.
   */
  private async reissue(
    token: string,
    storedToken: RefreshToken,
  ): Promise<RotatedRefreshToken> {
    const now = new Date();
    const revokedAt = storedToken.revokedAt ?? now;
    const sinceMs = now.getTime() - revokedAt.getTime();
    const inGrace =
      storedToken.revokedReason === 'ROTATED' && sinceMs <= this.reuseGraceMs;

    if (inGrace) {
      const replacementToken = this.successorOf(token);
      const replacement = await this.tokens
        .findOne({
          tokenHash: this.hashToken(replacementToken),
          familyId: storedToken.familyId,
          revokedAt: null,
          expiresAt: { $gt: now },
        })
        .exec();
      if (replacement) {
        this.logger.log(
          `Refresh token sent again ${Math.round(sinceMs / 1000)}s after rotation; reissued its replacement (family ${storedToken.familyId})`,
        );
        return {
          token: replacementToken,
          expiresIn: this.refreshTokenTtl,
          userId: replacement.userId,
          actorId: replacement.actorId,
        };
      }
    }

    await this.revokeFamily(storedToken.familyId, now, 'REUSE_DETECTED');
    this.logger.warn(
      `Refresh token reuse detected: family ${storedToken.familyId} of user ${storedToken.userId} revoked; the token was revoked ${Math.round(sinceMs / 1000)}s earlier (${storedToken.revokedReason ?? 'unknown reason'})`,
    );
    throw new UnauthenticatedException(
      'UNAUTHORIZED',
      'Refresh token reuse detected',
    );
  }

  async revoke(token: string): Promise<void> {
    const storedToken = await this.tokens
      .findOne({ tokenHash: this.hashToken(token) })
      .exec();
    if (!storedToken) return;
    await this.revokeFamily(storedToken.familyId, new Date(), 'LOGOUT');
  }

  /** Also ends every page session the user acts in. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.tokens.updateMany(
      { $or: [{ userId }, { actorId: userId }], revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'REVOKED' } },
    );
  }

  /** Ends a member's sessions as one page, e.g. once they are removed from it. */
  async revokePageSessions(pageUserId: string, actorId: string): Promise<void> {
    await this.tokens.updateMany(
      { userId: pageUserId, actorId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'REVOKED' } },
    );
  }

  /**
   * Ends the session `token` belongs to before it is swapped for another
   * identity. The token must be live and belong to `owner` (the identity the
   * access token speaks for), so a stolen access token alone cannot open a
   * new 30-day session.
   */
  async revokeForSwitch(token: string, owner: SessionOwner): Promise<void> {
    const storedToken = await this.tokens
      .findOne({ tokenHash: this.hashToken(token) })
      .exec();
    const now = new Date();
    if (
      !storedToken ||
      storedToken.revokedAt !== null ||
      storedToken.expiresAt <= now ||
      storedToken.userId !== owner.userId ||
      storedToken.actorId !== owner.actorId
    )
      throw new UnauthenticatedException(
        'UNAUTHORIZED',
        'Invalid refresh token',
      );
    await this.revokeFamily(storedToken.familyId, now, 'SWITCHED');
  }

  private async revokeFamily(
    familyId: string,
    revokedAt: Date,
    revokedReason: RefreshTokenRevocation,
  ): Promise<void> {
    await this.tokens.updateMany(
      { familyId, revokedAt: null },
      { $set: { revokedAt, revokedReason } },
    );
  }

  private generateToken(): string {
    return randomBytes(48).toString('base64url');
  }

  /** The token that replaces `token` when it rotates: the same every time, unknowable without the server secret. */
  private successorOf(token: string): string {
    this.successorKey ??= Buffer.from(
      hkdfSync(
        'sha256',
        this.configService.getOrThrow<string>('JWT_SECRET'),
        'vedora-refresh-token',
        'successor',
        48,
      ),
    );
    return createHmac('sha384', this.successorKey)
      .update(token)
      .digest('base64url');
  }

  private async insertToken(
    session: ClientSession,
    familyId: string,
    token: string,
    { userId, actorId }: SessionOwner,
  ): Promise<void> {
    await this.tokens.create(
      [
        {
          _id: randomUUID(),
          familyId,
          tokenHash: this.hashToken(token),
          userId,
          actorId,
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
    if (!user)
      throw new UnauthenticatedException(
        'UNAUTHORIZED',
        'Account no longer exists',
      );
    assertAccountActive(user.status);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private expiresAt(): Date {
    return new Date(Date.now() + this.refreshTokenTtl * 1000);
  }
}
