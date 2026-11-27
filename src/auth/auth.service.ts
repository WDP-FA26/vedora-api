import { runtimeConfig } from '../config/runtime-config.js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, truncates } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { AccountStatus } from '../mongo/models.js';
import { assertAccountActive } from '../auth-core/account-access.js';
import { AccountsService } from '../users/accounts.service.js';
import { type PublicUser, toPublicUser } from '../users/public-user.js';
import type { AuthenticatedUser, JwtPayload } from '../auth-core/auth.types.js';
import {
  AuthResponseDto,
  CurrentUserDto,
  SessionActorDto,
} from './dto/auth-response.dto.js';
import {
  ResendVerificationDto,
  VerificationRequiredDto,
  VerifyEmailDto,
} from './dto/email-verification.dto.js';
import { LoginDto } from './dto/login.dto.js';
import {
  ForgotPasswordDto,
  ResetPasswordDto,
} from './dto/password-reset.dto.js';
import { RegisterDto } from '../users/dto/register.dto.js';
import {
  EmailVerificationService,
  SendResult,
} from './email-verification.service.js';
import { hashPassword } from '../auth-core/password.js';
import { PasswordResetService } from './password-reset.service.js';
import { GoogleProfileUser } from './google-auth.types.js';
import {
  IssuedRefreshToken,
  RefreshTokensService,
} from './refresh-tokens.service.js';
import { AccessDeniedException } from '../common/exceptions/access-denied.exception.js';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { QuotaReachedException } from '../common/exceptions/quota-reached.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { UnauthenticatedException } from '../common/exceptions/unauthenticated.exception.js';

const DUMMY_PASSWORD_HASH =
  '$2b$12$eMcBdg./eJofytkZPDuoGOyif9iLSXILzYk0MY95Vq6P7M6.c9nTe';

const UNVERIFIED_ACCOUNT_TTL_MS =
  runtimeConfig.AUTH_UNVERIFIED_ACCOUNT_TTL_SECONDS * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly accessTokenTtl: number;

  constructor(
    private readonly accounts: AccountsService,
    private readonly jwtService: JwtService,
    private readonly refreshTokensService: RefreshTokensService,
    private readonly emailVerificationService: EmailVerificationService,
    private readonly passwordResetService: PasswordResetService,
    configService: ConfigService,
  ) {
    this.accessTokenTtl = configService.get<number>('JWT_ACCESS_TTL', 3600);
  }

  async register(dto: RegisterDto): Promise<VerificationRequiredDto> {
    const passwordHash = await hashPassword(dto.password);
    await this.accounts.deleteStaleUnverified(
      dto,
      new Date(Date.now() - UNVERIFIED_ACCOUNT_TTL_MS),
    );
    const user = await this.accounts.create({
      username: dto.username,
      passwordHash,
      fullName: dto.fullName,
      email: dto.email,
    });

    await this.sendCodeQuietly(user);
    return { email: user.email };
  }

  async login(
    dto: Pick<LoginDto, 'username' | 'password'>,
  ): Promise<AuthResponseDto> {
    const user = await this.accounts.findByUsername(dto.username);
    const hashMatches = await compare(
      dto.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    const passwordMatches = hashMatches && !truncates(dto.password);

    if (!user || !passwordMatches) {
      throw new UnauthenticatedException(
        'UNAUTHORIZED',
        'Invalid username or password',
      );
    }
    if (
      user.status === AccountStatus.SUSPENDED ||
      user.status === AccountStatus.DELETED
    ) {
      assertAccountActive(user.status);
    }
    if (!user.emailVerifiedAt) {
      await this.sendCodeQuietly(user);
      throw new AccessDeniedException(
        'EMAIL_NOT_VERIFIED',
        'Email address is not verified',
        { email: user.email },
      );
    }

    return this.createAuthResponse(toPublicUser(user));
  }

  async verifyEmail(dto: VerifyEmailDto): Promise<AuthResponseDto> {
    const user = await this.accounts.findByEmail(dto.email);
    if (
      user &&
      (user.status === AccountStatus.SUSPENDED ||
        user.status === AccountStatus.DELETED)
    ) {
      throw new InvalidInputException(
        'BAD_REQUEST',
        'Invalid or expired verification code',
      );
    }
    const result =
      user && !user.emailVerifiedAt
        ? await this.emailVerificationService.verify(user, dto.code)
        : 'invalid';
    if (result === 'locked') {
      throw new QuotaReachedException(
        'VERIFY_LIMIT_REACHED',
        'Too many wrong codes for this email; try again tomorrow',
      );
    }
    if (!user || result !== 'verified') {
      throw new InvalidInputException(
        'BAD_REQUEST',
        'Invalid or expired verification code',
      );
    }

    return this.createAuthResponse(toPublicUser(user));
  }

  async resendVerification(dto: ResendVerificationDto): Promise<void> {
    const user = await this.accounts.findByEmail(dto.email);
    if (!user || user.emailVerifiedAt) return;

    let result: SendResult;
    try {
      result = await this.emailVerificationService.send(user);
    } catch (error) {
      this.logger.error(`Verification email failed: ${String(error)}`);
      throw new FeatureUnavailableException(
        'SERVICE_UNAVAILABLE',
        'Could not send the email',
      );
    }
    if (result === 'limit') {
      throw new QuotaReachedException(
        'RESEND_LIMIT_REACHED',
        'Verification code resend limit reached; try again later',
      );
    }
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<void> {
    const user = await this.accounts.findByEmail(dto.email);
    if (!user) return;

    let result: SendResult;
    try {
      result = await this.passwordResetService.send(user);
    } catch (error) {
      this.logger.error(`Password reset email failed: ${String(error)}`);
      throw new FeatureUnavailableException(
        'SERVICE_UNAVAILABLE',
        'Could not send the email',
      );
    }
    if (result === 'limit') {
      throw new QuotaReachedException(
        'RESEND_LIMIT_REACHED',
        'Password reset code limit reached; try again later',
      );
    }
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const passwordHash = await hashPassword(dto.password);
    const user = await this.accounts.findByEmail(dto.email);
    const result = user
      ? await this.passwordResetService.reset(user, dto.code, passwordHash)
      : 'invalid';
    if (result === 'locked') {
      throw new QuotaReachedException(
        'VERIFY_LIMIT_REACHED',
        'Too many wrong codes for this email; try again tomorrow',
      );
    }
    if (!user || result !== 'reset') {
      throw new InvalidInputException(
        'BAD_REQUEST',
        'Invalid or expired reset code',
      );
    }
    await this.refreshTokensService.revokeAllForUser(user.id);
  }

  async getCurrentUser(userId: string): Promise<PublicUser> {
    const user = await this.accounts.findPublicById(userId);
    if (!user)
      throw new ResourceNotFoundException('NOT_FOUND', 'User not found');
    assertAccountActive(user.status);
    return user;
  }

  async me(current: AuthenticatedUser): Promise<CurrentUserDto> {
    const [user, actor] = await Promise.all([
      this.getCurrentUser(current.sub),
      this.findActor(current.actorId),
    ]);
    return { ...user, actor };
  }

  async refresh(refreshToken: string): Promise<AuthResponseDto> {
    const rotatedToken = await this.refreshTokensService.rotate(refreshToken);
    const user = await this.getCurrentUser(rotatedToken.userId);
    return this.createAuthResponse(user, rotatedToken, rotatedToken.actorId);
  }

  async switchAccount(
    current: AuthenticatedUser,
    refreshToken: string,
    pageId: string | null,
  ): Promise<AuthResponseDto> {
    const personId = current.actorId ?? current.sub;
    if (pageId === personId)
      throw new InvalidInputException(
        'BAD_REQUEST',
        'Pass null to switch back to your own account',
      );
    if (pageId !== null && !(await this.accounts.managesPage(personId, pageId)))
      throw new AccessDeniedException(
        'FORBIDDEN',
        'You do not manage this page',
      );
    await this.refreshTokensService.revokeForSwitch(refreshToken, {
      userId: current.sub,
      actorId: current.actorId,
    });
    if (pageId === null) {
      return this.createAuthResponse(await this.getCurrentUser(personId));
    }
    const page = await this.getCurrentUser(pageId);
    const issued = await this.refreshTokensService.issue(pageId, personId);
    return this.createAuthResponse(page, issued, personId);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.refreshTokensService.revoke(refreshToken);
  }

  async googleLogin(profile: GoogleProfileUser): Promise<AuthResponseDto> {
    const googleUser = await this.accounts.findByGoogleId(profile.googleId);
    if (googleUser) {
      assertAccountActive(googleUser.status);
      return this.createAuthResponse(toPublicUser(googleUser));
    }

    const existingUser = await this.accounts.findByEmail(profile.email);
    if (existingUser) {
      if (
        existingUser.status === AccountStatus.SUSPENDED ||
        existingUser.status === AccountStatus.DELETED
      ) {
        assertAccountActive(existingUser.status);
      }
      const user = await this.accounts.linkGoogleAccount(
        existingUser,
        profile.googleId,
      );
      if (!existingUser.emailVerifiedAt) {
        await Promise.all([
          this.refreshTokensService.revokeAllForUser(user.id),
          this.emailVerificationService.discard(user.id),
        ]);
      }
      return this.createAuthResponse(user);
    }

    const user = await this.accounts.create({
      username: `g.${randomBytes(12).toString('hex')}`,
      googleId: profile.googleId,
      fullName: profile.fullName,
      email: profile.email,
      emailVerifiedAt: new Date(),
      status: AccountStatus.ACTIVE,
    });
    return this.createAuthResponse(user);
  }

  private async sendCodeQuietly(user: { id: string; email: string }) {
    await this.emailVerificationService.send(user).catch((error: unknown) => {
      this.logger.error(`Verification email failed: ${String(error)}`);
    });
  }

  private async findActor(
    actorId: string | null,
  ): Promise<SessionActorDto | null> {
    if (actorId === null) return null;
    const actor = await this.getCurrentUser(actorId);
    return {
      id: actor.id,
      username: actor.username,
      fullName: actor.fullName,
      avatarUrl: actor.avatarUrl,
    };
  }

  private async createAuthResponse(
    user: PublicUser,
    issuedRefreshToken?: IssuedRefreshToken,
    actorId: string | null = null,
  ): Promise<AuthResponseDto> {
    user = await this.getCurrentUser(user.id);
    const payload: JwtPayload =
      actorId === null
        ? { sub: user.id, username: user.username }
        : { sub: user.id, username: user.username, act: actorId };
    const [accessToken, refreshToken, actor] = await Promise.all([
      this.jwtService.signAsync(payload),
      issuedRefreshToken
        ? Promise.resolve(issuedRefreshToken)
        : this.refreshTokensService.issue(user.id),
      this.findActor(actorId),
    ]);

    return {
      accessToken,
      refreshToken: refreshToken.token,
      tokenType: 'Bearer',
      accessTokenExpiresIn: this.accessTokenTtl,
      refreshTokenExpiresIn: refreshToken.expiresIn,
      user,
      actor,
    };
  }
}
