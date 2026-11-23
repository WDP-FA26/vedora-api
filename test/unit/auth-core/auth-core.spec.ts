import { Global, Module, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { compare } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { AuthCoreModule } from '../../../src/auth-core/auth-core.module.js';
import { extractBearerToken } from '../../../src/auth-core/bearer-token.js';
import { JwtAuthGuard } from '../../../src/auth-core/jwt-auth.guard.js';
import { OptionalJwtAuthGuard } from '../../../src/auth-core/optional-jwt-auth.guard.js';
import { PersonalSessionGuard } from '../../../src/auth-core/personal-session.guard.js';
import { hashPassword } from '../../../src/auth-core/password.js';
import { Roles, ROLES_KEY } from '../../../src/auth-core/roles.decorator.js';
import { RolesGuard } from '../../../src/auth-core/roles.guard.js';
import { UserThrottlerGuard } from '../../../src/auth-core/user-throttler.guard.js';
import { AccessDeniedException } from '../../../src/common/exceptions/access-denied.exception.js';
import { InvalidInputException } from '../../../src/common/exceptions/invalid-input.exception.js';
import { UnauthenticatedException } from '../../../src/common/exceptions/unauthenticated.exception.js';
import {
  AccountStatus,
  User,
  UserRole,
  WorkspaceMember,
} from '../../../src/mongo/models.js';

function createHttpContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => vi.fn(),
    }),
    getHandler: () => (() => undefined) as () => void,
    getClass: () => class DummyController {},
  } as unknown as ExecutionContext;
}

describe('auth-core', () => {
  describe('extractBearerToken', () => {
    it('extracts token case-insensitively and rejects malformed values', () => {
      expect(extractBearerToken(undefined)).toBeUndefined();
      expect(extractBearerToken('')).toBeUndefined();
      expect(extractBearerToken('Basic abc')).toBeUndefined();
      expect(extractBearerToken('Bearer')).toBeUndefined();
      expect(extractBearerToken('Bearer ')).toBeUndefined();
      expect(extractBearerToken('Bearer my-jwt')).toBe('my-jwt');
      expect(extractBearerToken('bearer my-jwt')).toBe('my-jwt');
    });
  });

  describe('hashPassword', () => {
    it('hashes passwords within 72 UTF-8 bytes and rejects longer ones', async () => {
      const hashed = await hashPassword('StrongPassword123!');
      expect(await compare('StrongPassword123!', hashed)).toBe(true);

      await expect(hashPassword('a'.repeat(73))).rejects.toBeInstanceOf(
        InvalidInputException,
      );
      await expect(hashPassword('🔥'.repeat(19))).rejects.toBeInstanceOf(
        InvalidInputException,
      );
    });
  });

  describe('JwtAuthGuard & OptionalJwtAuthGuard', () => {
    const verifyAsync = vi.fn();
    const exec = vi.fn();
    const select = vi.fn(() => ({ exec }));
    const findOne = vi.fn(() => ({ select }));
    const jwtService = { verifyAsync } as unknown as JwtService;
    const usersModel = { findOne } as unknown as never;
    const membersModel = { exists: vi.fn() } as unknown as never;
    const guard = new JwtAuthGuard(jwtService, usersModel, membersModel);
    const optionalGuard = new OptionalJwtAuthGuard(
      jwtService,
      usersModel,
      membersModel,
    );

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('rejects requests without a bearer token', async () => {
      await expect(
        guard.canActivate(createHttpContext({ headers: {} })),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401 });
    });

    it('rejects tokens whose payload claims are malformed or unverified', async () => {
      verifyAsync.mockResolvedValueOnce({ sub: 'not-a-uuid', username: 'a' });
      await expect(
        guard.canActivate(
          createHttpContext({ headers: { authorization: 'Bearer tok' } }),
        ),
      ).rejects.toBeInstanceOf(UnauthenticatedException);

      verifyAsync.mockResolvedValueOnce({ sub: randomUUID(), username: '' });
      await expect(
        guard.canActivate(
          createHttpContext({ headers: { authorization: 'Bearer tok' } }),
        ),
      ).rejects.toBeInstanceOf(UnauthenticatedException);

      verifyAsync.mockRejectedValueOnce(new Error('expired'));
      await expect(
        guard.canActivate(
          createHttpContext({ headers: { authorization: 'Bearer tok' } }),
        ),
      ).rejects.toBeInstanceOf(UnauthenticatedException);
    });

    it('rejects when user no longer exists or is not ACTIVE', async () => {
      const sub = randomUUID();
      verifyAsync.mockResolvedValue({ sub, username: 'alice' });

      exec.mockResolvedValueOnce(null);
      await expect(
        guard.canActivate(
          createHttpContext({ headers: { authorization: 'Bearer tok' } }),
        ),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      exec.mockResolvedValueOnce({
        id: sub,
        username: 'alice',
        role: UserRole.USER,
        status: AccountStatus.SUSPENDED,
      });
      await expect(
        guard.canActivate(
          createHttpContext({ headers: { authorization: 'Bearer tok' } }),
        ),
      ).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED', statusCode: 401 });

      exec.mockResolvedValueOnce({
        id: sub,
        username: 'alice',
        role: UserRole.USER,
        status: AccountStatus.PENDING_EMAIL,
      });
      await expect(
        guard.canActivate(
          createHttpContext({ headers: { authorization: 'Bearer tok' } }),
        ),
      ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE', statusCode: 401 });
    });

    it('attaches DB-sourced user id, username, and role for active accounts', async () => {
      const sub = randomUUID();
      verifyAsync.mockResolvedValueOnce({ sub, username: 'stale-name' });
      exec.mockResolvedValueOnce({
        id: sub,
        username: 'current-name',
        role: UserRole.ADMIN,
        status: AccountStatus.ACTIVE,
      });
      const request: Record<string, unknown> = {
        headers: { authorization: 'Bearer valid' },
      };

      const allowed = await guard.canActivate(createHttpContext(request));
      expect(allowed).toBe(true);
      expect(request.user).toEqual({
        sub,
        username: 'current-name',
        role: UserRole.ADMIN,
        actorId: null,
      });
    });

    it('OptionalJwtAuthGuard allows missing Authorization header and validates when header is present', async () => {
      await expect(
        optionalGuard.canActivate(createHttpContext({ headers: {} })),
      ).resolves.toBe(true);
      expect(verifyAsync).not.toHaveBeenCalled();

      await expect(
        optionalGuard.canActivate(
          createHttpContext({ headers: { authorization: '' } }),
        ),
      ).rejects.toBeInstanceOf(UnauthenticatedException);
    });
  });

  describe('PersonalSessionGuard', () => {
    const guard = new PersonalSessionGuard();

    it('allows personal sessions and rejects page sessions', () => {
      expect(
        guard.canActivate(
          createHttpContext({ user: { sub: 'u1', actorId: null } }),
        ),
      ).toBe(true);

      let thrown: unknown;
      try {
        guard.canActivate(
          createHttpContext({ user: { sub: 'page-1', actorId: 'u1' } }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AccessDeniedException);
      expect(thrown).toMatchObject({
        code: 'PAGE_SESSION_NOT_ALLOWED',
        statusCode: 403,
      });
    });
  });

  describe('RolesGuard & Roles decorator', () => {
    it('attaches ROLES_KEY metadata and enforces role checks', () => {
      class TestController {
        @Roles(UserRole.ADMIN)
        adminOnly(): void {}
      }
      const reflector = new Reflector();
      const metadata = reflector.get<UserRole[]>(
        ROLES_KEY,
        TestController.prototype.adminOnly,
      );
      expect(metadata).toEqual([UserRole.ADMIN]);

      const mockReflector = {
        getAllAndOverride: vi.fn(),
      } as unknown as Reflector;
      const rolesGuard = new RolesGuard(mockReflector);

      vi.mocked(mockReflector.getAllAndOverride).mockReturnValueOnce(undefined);
      expect(rolesGuard.canActivate(createHttpContext({}))).toBe(true);

      vi.mocked(mockReflector.getAllAndOverride).mockReturnValueOnce([
        UserRole.ADMIN,
      ]);
      expect(() =>
        rolesGuard.canActivate(
          createHttpContext({ user: { role: UserRole.USER } }),
        ),
      ).toThrow(AccessDeniedException);

      vi.mocked(mockReflector.getAllAndOverride).mockReturnValueOnce([
        UserRole.ADMIN,
      ]);
      expect(() => rolesGuard.canActivate(createHttpContext({}))).toThrow(
        AccessDeniedException,
      );

      vi.mocked(mockReflector.getAllAndOverride).mockReturnValueOnce([
        UserRole.ADMIN,
      ]);
      expect(
        rolesGuard.canActivate(
          createHttpContext({ user: { role: UserRole.ADMIN } }),
        ),
      ).toBe(true);
    });
  });

  describe('UserThrottlerGuard', () => {
    it('tracks throttle limits by authenticated user sub', async () => {
      class ExposedUserThrottlerGuard extends UserThrottlerGuard {
        track(req: { user: { sub: string } }): Promise<string> {
          return this.getTracker(req as never);
        }
      }
      const guard = Object.create(
        ExposedUserThrottlerGuard.prototype,
      ) as ExposedUserThrottlerGuard;
      await expect(guard.track({ user: { sub: 'user-123' } })).resolves.toBe(
        'user-123',
      );
    });

    it('skips throttling for admins only', async () => {
      class ExposedUserThrottlerGuard extends UserThrottlerGuard {
        skips(context: ExecutionContext): Promise<boolean> {
          return this.shouldSkip(context);
        }
      }
      const guard = Object.create(
        ExposedUserThrottlerGuard.prototype,
      ) as ExposedUserThrottlerGuard;
      const contextFor = (role: UserRole) =>
        createHttpContext({ user: { sub: 'user-1', role } });

      await expect(guard.skips(contextFor(UserRole.ADMIN))).resolves.toBe(true);
      await expect(guard.skips(contextFor(UserRole.USER))).resolves.toBe(false);
    });
  });

  describe('AuthCoreModule', () => {
    it('configures JwtModule using ConfigService JWT_SECRET and JWT_ACCESS_TTL', async () => {
      @Global()
      @Module({
        providers: [
          { provide: getModelToken(User.name), useValue: {} },
          { provide: getModelToken(WorkspaceMember.name), useValue: {} },
        ],
        exports: [
          getModelToken(User.name),
          getModelToken(WorkspaceMember.name),
        ],
      })
      class FakeMongoModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            load: [
              () => ({
                JWT_SECRET: 'super-secret-jwt-key-with-at-least-32-chars',
                JWT_ACCESS_TTL: 1800,
              }),
            ],
          }),
          FakeMongoModule,
          AuthCoreModule,
        ],
      }).compile();

      const jwt = moduleRef.get(JwtService);
      const token = await jwt.signAsync({ sub: randomUUID(), username: 'u' });
      expect(typeof token).toBe('string');
      expect(moduleRef.get(ConfigService).get('JWT_ACCESS_TTL')).toBe(1800);
      await moduleRef.close();
    });
  });
});
