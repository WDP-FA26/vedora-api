import { randomBytes } from 'node:crypto';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { GoogleProfileUser } from './google-auth.types.js';

export interface GoogleAuthorization {
  /** Google's consent screen URL. */
  url: string;
  /** Nonce the caller must store and compare with `state` on return. */
  state: string;
  /** PKCE secret the caller must keep and send back with the `code`. */
  codeVerifier: string;
}

/**
 * Google's authorization-code flow with PKCE. Google redirects the browser to
 * the frontend (`GOOGLE_CALLBACK_URL`), never to this API: the frontend keeps
 * `state` and `codeVerifier` from `authorize`, checks `state`, then hands the
 * `code` and verifier to `exchangeCode`.
 */
@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);
  private readonly clientId: string;
  private readonly client: OAuth2Client | null;

  constructor(configService: ConfigService) {
    this.clientId = configService.get<string>('GOOGLE_CLIENT_ID', '');
    const clientSecret = configService.get<string>('GOOGLE_CLIENT_SECRET', '');
    const redirectUri = configService.get<string>('GOOGLE_CALLBACK_URL', '');
    this.client =
      this.clientId && clientSecret && redirectUri
        ? new OAuth2Client({
            clientId: this.clientId,
            clientSecret,
            redirectUri,
          })
        : null;
  }

  async authorize(): Promise<GoogleAuthorization> {
    const client = this.requireClient();
    const { codeVerifier, codeChallenge } =
      await client.generateCodeVerifierAsync();
    const state = randomBytes(32).toString('base64url');

    const url = client.generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      prompt: 'select_account',
    });
    return { url, state, codeVerifier };
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<GoogleProfileUser> {
    const client = this.requireClient();

    let idToken: string | null | undefined;
    try {
      ({
        tokens: { id_token: idToken },
      } = await client.getToken({ code, codeVerifier }));
    } catch (error) {
      // invalid_grant: expired or reused code, wrong verifier or redirect URI.
      this.logger.warn(`Google code exchange failed: ${String(error)}`);
      throw new UnauthorizedException('Google sign-in failed');
    }
    if (!idToken) {
      throw new UnauthorizedException('Google sign-in failed');
    }

    const ticket = await client
      .verifyIdToken({ idToken, audience: this.clientId })
      .catch(() => {
        throw new UnauthorizedException('Google sign-in failed');
      });
    const payload = ticket.getPayload();
    const email = payload?.email?.trim().toLowerCase();
    if (!payload || !email || payload.email_verified !== true) {
      throw new UnauthorizedException('Google email is missing or unverified');
    }

    return {
      googleId: payload.sub,
      email,
      fullName: payload.name?.trim() || email.split('@')[0],
    };
  }

  private requireClient(): OAuth2Client {
    if (!this.client) {
      throw new ServiceUnavailableException('Google OAuth is not configured');
    }
    return this.client;
  }
}
