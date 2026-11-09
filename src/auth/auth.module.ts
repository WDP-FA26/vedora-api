import { Module } from '@nestjs/common';
import { CaptchaModule } from '../captcha/captcha.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { GoogleOAuthService } from './google-oauth.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { RefreshTokensService } from './refresh-tokens.service.js';

@Module({
  imports: [UsersModule, CaptchaModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    RefreshTokensService,
    GoogleOAuthService,
    EmailVerificationService,
    PasswordResetService,
  ],
})
export class AuthModule {}
