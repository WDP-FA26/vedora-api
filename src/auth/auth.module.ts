import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RefreshTokensService } from './refresh-tokens.service';
import { GoogleOAuthService } from './google-oauth.service';
import { EmailVerificationService } from './email-verification.service';
import { RolesGuard } from './roles.guard';

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
    AuthService,
    JwtAuthGuard,
    RolesGuard,
    RefreshTokensService,
    GoogleOAuthService,
    EmailVerificationService,
  ],
  exports: [JwtAuthGuard, RolesGuard, JwtModule],
})
export class AuthModule {}
