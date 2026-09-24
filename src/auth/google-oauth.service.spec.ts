import {
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { GoogleOAuthService } from './google-oauth.service';

describe('GoogleOAuthService', () => {
  const env: Record<string, string> = {
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_CALLBACK_URL: 'https://vedora.example.com/auth/google',
  };
  const configFrom = (values: Record<string, string>) =>
    ({
      get: (key: string, fallback?: string) => values[key] ?? fallback,
    }) as unknown as ConfigService;

  const service = new GoogleOAuthService(configFrom(env));
  const verifier = 'v'.repeat(43);

  // getToken/verifyIdToken have callback overloads; plain mocks keep the
  // Promise-returning signature simple to stub.
  let getToken: jest.Mock;
  let verifyIdToken: jest.Mock;

  beforeEach(() => {
    getToken = jest.spyOn(
      OAuth2Client.prototype,
      'getToken',
    ) as unknown as jest.Mock;
    verifyIdToken = jest.spyOn(
      OAuth2Client.prototype,
      'verifyIdToken',
    ) as unknown as jest.Mock;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  function mockIdToken(payload: Record<string, unknown>) {
    getToken.mockResolvedValue({ tokens: { id_token: 'id-token' } });
    verifyIdToken.mockResolvedValue({ getPayload: () => payload });
  }

  it('builds a consent URL with state, PKCE and the frontend redirect', async () => {
    const { url, state, codeVerifier } = await service.authorize();
    const params = new URL(url).searchParams;

    expect(params.get('client_id')).toBe('client-id');
    expect(params.get('redirect_uri')).toBe(
      'https://vedora.example.com/auth/google',
    );
    expect(params.get('state')).toBe(state);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(state.length).toBeGreaterThanOrEqual(32);
  });

  it('exchanges the code with the verifier and returns the profile', async () => {
    mockIdToken({
      sub: 'google-sub',
      email: ' Hello@Vedora.vn ',
      email_verified: true,
      name: 'Vedora User',
    });

    await expect(service.exchangeCode('code-1', verifier)).resolves.toEqual({
      googleId: 'google-sub',
      email: 'hello@vedora.vn',
      fullName: 'Vedora User',
    });
    expect(getToken).toHaveBeenCalledWith({
      code: 'code-1',
      codeVerifier: verifier,
    });
    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: 'id-token',
      audience: 'client-id',
    });
  });

  it('rejects a code Google refuses', async () => {
    getToken.mockRejectedValue(new Error('invalid_grant'));

    await expect(service.exchangeCode('bad', verifier)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an unverified email', async () => {
    mockIdToken({ sub: 'google-sub', email: 'a@b.c', email_verified: false });

    await expect(service.exchangeCode('code', verifier)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('returns 503 when Google is not configured', async () => {
    const unconfigured = new GoogleOAuthService(configFrom({}));

    await expect(unconfigured.authorize()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
