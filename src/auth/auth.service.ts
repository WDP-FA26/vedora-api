import {
  Injectable,
  NotFoundException,
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
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { hashPassword } from './password';
import { GoogleProfileUser } from './google-auth.types';
import {
  IssuedRefreshToken,
  RefreshTokensService,
} from './refresh-tokens.service';

const DUMMY_PASSWORD_HASH =
  '$2b$12$eMcBdg./eJofytkZPDuoGOyif9iLSXILzYk0MY95Vq6P7M6.c9nTe';

@Injectable()
export class AuthService {
  private readonly accessTokenTtl: number;

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly refreshTokensService: RefreshTokensService,
    configService: ConfigService,
  ) {
    this.accessTokenTtl = configService.get<number>('JWT_ACCESS_TTL', 3600);
  }

  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    const passwordHash = await hashPassword(dto.password);
    const user = await this.usersService.create({
      username: dto.username,
      passwordHash,
      fullName: dto.fullName,
      email: dto.email,
    });

    return this.createAuthResponse(user);
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

    const publicUser: PublicUser = {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      email: user.email,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
    return this.createAuthResponse(publicUser);
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
    const user = existingUser
      ? await this.usersService.linkGoogleAccount(
          existingUser.id,
          profile.googleId,
        )
      : await this.usersService.create({
          username: `g.${randomBytes(12).toString('hex')}`,
          googleId: profile.googleId,
          fullName: profile.fullName,
          email: profile.email,
        });

    return this.createAuthResponse(user);
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
