import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy, VerifyCallback } from 'passport-google-oauth20';
import { GoogleProfileUser } from './google-auth.types';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(configService: ConfigService) {
    super({
      clientID:
        configService.get<string>('GOOGLE_CLIENT_ID') ||
        'google-oauth-not-configured',
      clientSecret:
        configService.get<string>('GOOGLE_CLIENT_SECRET') ||
        'google-oauth-not-configured',
      callbackURL:
        configService.get<string>('GOOGLE_CALLBACK_URL') ||
        'http://localhost:3000/api/v1/auth/google/callback',
      scope: ['email', 'profile'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): void {
    const email = profile.emails?.[0]?.value.trim().toLowerCase();
    const rawProfile: unknown = profile._json;
    const emailVerified =
      typeof rawProfile === 'object' &&
      rawProfile !== null &&
      (rawProfile as Record<string, unknown>).email_verified === true;

    if (!email || !emailVerified) {
      done(new UnauthorizedException('Google email is missing or unverified'));
      return;
    }

    const user: GoogleProfileUser = {
      googleId: profile.id,
      email,
      fullName: profile.displayName?.trim() || email.split('@')[0],
    };
    done(null, user);
  }
}
