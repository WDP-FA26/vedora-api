import { Logger } from '@nestjs/common';
import { FeatureUnavailableException } from '../common/exceptions/feature-unavailable.exception.js';
import { UnauthenticatedException } from '../common/exceptions/unauthenticated.exception.js';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OAuth2Client } from 'google-auth-library';
import type { Mock } from 'vitest';
import { GoogleOAuthService } from './google-oauth.service.js';

describe('GoogleOAuthService', () => {
  const env: Record<string, string> = {
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_CALLBACK_URL: 'https://vedora.example.com/auth/google',
  };
  async function createService(values: Record<string, string>) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        GoogleOAuthService,
        { provide: ConfigService, useValue: new ConfigService(values) },
      ],
    }).compile();
    return moduleRef.get(GoogleOAuthService);
  }

  let service: GoogleOAuthService;
  const verifier = 'v'.repeat(43);

  // getToken/verifyIdToken have callback overloads, so their spies are typed
  // by the callback form; a generic Mock lets us stub the Promise form.
  let getToken: Mock;
  let verifyIdToken: Mock;

  beforeEach(async () => {
    service = await createService(env);
    getToken = vi.spyOn(OAuth2Client.prototype, 'getToken');
    verifyIdToken = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken');
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

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
      UnauthenticatedException,
    );
  });

  it('rejects an unverified email', async () => {
    mockIdToken({ sub: 'google-sub', email: 'a@b.c', email_verified: false });

    await expect(service.exchangeCode('code', verifier)).rejects.toBeInstanceOf(
      UnauthenticatedException,
    );
  });

  it('returns 503 when Google is not configured', async () => {
    const unconfigured = await createService({});

    await expect(unconfigured.authorize()).rejects.toBeInstanceOf(
      FeatureUnavailableException,
    );
  });
});
