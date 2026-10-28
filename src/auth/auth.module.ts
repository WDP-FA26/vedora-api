import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard.js';
import { RefreshTokensService } from './refresh-tokens.service.js';
import { GoogleOAuthService } from './google-oauth.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { RolesGuard } from './roles.guard.js';
import { TurnstileService } from '../nutrition-chat/guest/turnstile.service.js';

@Global()
@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get<number>('JWT_ACCESS_TTL', 3600),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    TurnstileService,
    AuthService,
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    RolesGuard,
    RefreshTokensService,
    GoogleOAuthService,
    EmailVerificationService,
    PasswordResetService,
  ],
  exports: [JwtAuthGuard, OptionalJwtAuthGuard, RolesGuard, JwtModule],
})
export class AuthModule {}
