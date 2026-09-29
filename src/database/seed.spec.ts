import { PrismaClient, User, UserRole } from '@prisma/client';
import { hash } from 'bcryptjs';
import { mockDeep } from 'vitest-mock-extended';
import { seedDatabase } from './seed';

describe('Admin bootstrap', () => {
  beforeEach(() => {
    vi.stubEnv('SEED_USER_PASSWORD', 'StrongPassword123!');
  });
  afterEach(() => vi.unstubAllEnvs());

  const legacyAdmin: User = {
    id: 'c9ee4d58-ce10-4572-bd39-952a310ace87',
    username: 'vedora.admin',
    fullName: 'Vedora Admin',
    email: 'admin@vedora.local',
    bio: null,
    avatarUrl: null,
    avatarPathname: null,
    coverUrl: null,
    coverPathname: null,
    role: UserRole.USER,
    passwordHash: 'existing-password-hash',
    googleId: null,
    emailVerifiedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeAll(async () => {
    legacyAdmin.passwordHash = await hash('StrongPassword123!', 4);
  });

  it('creates the bootstrap account with admin access', async () => {
    const prisma = mockDeep<PrismaClient>();
    prisma.user.findUnique.mockResolvedValue(null);
    await seedDatabase(prisma);
    const [created] = prisma.user.create.mock.calls[0];
    expect(created.data).toMatchObject({
      username: 'vedora.admin',
      role: UserRole.ADMIN,
    });
  });

  it('promotes the legacy seed account without resetting its password', async () => {
    const prisma = mockDeep<PrismaClient>();
    prisma.user.findUnique.mockResolvedValue(legacyAdmin);
    await seedDatabase(prisma);
    const [updated] = prisma.user.update.mock.calls[0];
    expect(updated.data).toMatchObject({ role: UserRole.ADMIN });
    expect(updated.data).not.toHaveProperty('passwordHash');
  });

  it('refuses a verified account that claimed the seed identity with another password', async () => {
    const prisma = mockDeep<PrismaClient>();
    prisma.user.findUnique.mockResolvedValue({
      ...legacyAdmin,
      passwordHash: await hash('AnotherPassword123!', 4),
    });
    await expect(seedDatabase(prisma)).rejects.toThrow(
      'refusing to grant admin access',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each([
    { ...legacyAdmin, emailVerifiedAt: null },
    { ...legacyAdmin, username: 'someone.else' },
  ])(
    'refuses to promote an untrusted account at the seed email',
    async (user) => {
      const prisma = mockDeep<PrismaClient>();
      prisma.user.findUnique.mockResolvedValue(user);
      await expect(seedDatabase(prisma)).rejects.toThrow(
        'refusing to grant admin access',
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    },
  );
});
