import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { User } from '@prisma/client';
import { PublicUser, UsersService } from '../users/users.service';
import { JwtPayload } from './auth.types';
import { AuthResponseDto } from './dto/auth-response.dto';
import {
  ResendVerificationDto,
  VerificationRequiredDto,
  VerifyEmailDto,
} from './dto/email-verification.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import {
  EmailVerificationService,
  SendResult,
} from './email-verification.service';
import { hashPassword } from './password';
import { GoogleProfileUser } from './google-auth.types';
import {
  IssuedRefreshToken,
  RefreshTokensService,
} from './refresh-tokens.service';

const DUMMY_PASSWORD_HASH =
  '$2b$12$eMcBdg./eJofytkZPDuoGOyif9iLSXILzYk0MY95Vq6P7M6.c9nTe';

/** Unverified sign-ups older than this give up their email and username. */
const UNVERIFIED_ACCOUNT_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly accessTokenTtl: number;

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly refreshTokensService: RefreshTokensService,
    private readonly emailVerificationService: EmailVerificationService,
    configService: ConfigService,
  ) {
    this.accessTokenTtl = configService.get<number>('JWT_ACCESS_TTL', 3600);
  }

  /** Creates an unverified account and emails a code. No tokens until verified. */
  async register(dto: RegisterDto): Promise<VerificationRequiredDto> {
    const passwordHash = await hashPassword(dto.password);
    await this.usersService.deleteStaleUnverified(
      dto,
      new Date(Date.now() - UNVERIFIED_ACCOUNT_TTL_MS),
    );
    const user = await this.usersService.create({
      username: dto.username,
      passwordHash,
      fullName: dto.fullName,
      email: dto.email,
    });

    await this.sendCodeQuietly(user);
    return { email: user.email };
  }

  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const user = await this.usersService.findByUsername(dto.username);
    const passwordMatches = await compare(
      dto.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (!user || !passwordMatches) {
      throw new UnauthorizedException('Invalid username or password');
    }
    // Only reached with the right password, so it doesn't reveal the email.
    if (!user.emailVerifiedAt) {
      await this.sendCodeQuietly(user);
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Email address is not verified',
        email: user.email,
      });
    }

    return this.createAuthResponse(this.toPublicUser(user));
  }

  async verifyEmail(dto: VerifyEmailDto): Promise<AuthResponseDto> {
    const user = await this.usersService.findByEmail(dto.email);
    const result =
      user && !user.emailVerifiedAt
        ? await this.emailVerificationService.verify(user, dto.code)
        : 'invalid';
    if (result === 'locked') {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: 'VERIFY_LIMIT_REACHED',
          message: 'Too many wrong codes for this email; try again tomorrow',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!user || result !== 'verified') {
      throw new BadRequestException('Invalid or expired verification code');
    }

    return this.createAuthResponse(this.toPublicUser(user));
  }

  /**
   * Succeeds for unknown and verified emails too, so it can't be used to probe
   * which addresses exist. Only a pending sign-up can hit the resend limit.
   */
  async resendVerification(dto: ResendVerificationDto): Promise<void> {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user || user.emailVerifiedAt) return;

    let result: SendResult;
    try {
      result = await this.emailVerificationService.send(user);
    } catch (error) {
      this.logger.error(`Verification email failed: ${String(error)}`);
      throw new ServiceUnavailableException('Could not send the email');
    }
    if (result === 'limit') {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: 'RESEND_LIMIT_REACHED',
          message: 'Verification code resend limit reached; try again later',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async getCurrentUser(userId: string): Promise<PublicUser> {
    const user = await this.usersService.findPublicById(userId);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async refresh(refreshToken: string): Promise<AuthResponseDto> {
    const rotatedToken = await this.refreshTokensService.rotate(refreshToken);
    const user = await this.getCurrentUser(rotatedToken.userId);
    return this.createAuthResponse(user, rotatedToken);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.refreshTokensService.revoke(refreshToken);
  }

  async googleLogin(profile: GoogleProfileUser): Promise<AuthResponseDto> {
    const googleUser = await this.usersService.findByGoogleId(profile.googleId);
    if (googleUser) {
      return this.createAuthResponse(this.toPublicUser(googleUser));
    }

    const existingUser = await this.usersService.findByEmail(profile.email);
    if (existingUser) {
      const user = await this.usersService.linkGoogleAccount(
        existingUser,
        profile.googleId,
      );
      if (!existingUser.emailVerifiedAt) {
        // Whoever registered this address never proved they own it: end any
        // session they have and drop their pending code.
        await Promise.all([
          this.refreshTokensService.revokeAllForUser(user.id),
          this.emailVerificationService.discard(user.id),
        ]);
      }
      return this.createAuthResponse(user);
    }

    const user = await this.usersService.create({
      username: `g.${randomBytes(12).toString('hex')}`,
      googleId: profile.googleId,
      fullName: profile.fullName,
      email: profile.email,
      emailVerifiedAt: new Date(),
    });
    return this.createAuthResponse(user);
  }

  /**
   * Sign-up and login still succeed when the email can't be sent; the user
   * can ask for another code from the verification screen.
   */
  private async sendCodeQuietly(user: { id: string; email: string }) {
    await this.emailVerificationService.send(user).catch((error: unknown) => {
      this.logger.error(`Verification email failed: ${String(error)}`);
    });
  }

  private async createAuthResponse(
    user: PublicUser,
    issuedRefreshToken?: IssuedRefreshToken,
  ): Promise<AuthResponseDto> {
    const payload: JwtPayload = { sub: user.id, username: user.username };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload),
      issuedRefreshToken
        ? Promise.resolve(issuedRefreshToken)
        : this.refreshTokensService.issue(user.id),
    ]);

    return {
      accessToken,
      refreshToken: refreshToken.token,
      tokenType: 'Bearer',
      accessTokenExpiresIn: this.accessTokenTtl,
      refreshTokenExpiresIn: refreshToken.expiresIn,
      user,
    };
  }

  private toPublicUser(user: User): PublicUser {
    return {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      email: user.email,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
