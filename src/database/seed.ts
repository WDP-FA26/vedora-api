import { PrismaClient } from '@prisma/client';
import { hash, truncates } from 'bcryptjs';

export async function seedDatabase(prisma: PrismaClient): Promise<void> {
  const seedPassword = process.env.SEED_USER_PASSWORD;
  if (!seedPassword) {
    console.log('SEED_USER_PASSWORD is not set; skipping seed user.');
    return;
  }
  if (truncates(seedPassword)) {
    throw new Error('SEED_USER_PASSWORD must not exceed 72 UTF-8 bytes.');
  }

  const passwordHash = await hash(seedPassword, 12);
  const existingUser = await prisma.user.findUnique({
    where: { email: 'admin@vedora.local' },
  });

  if (existingUser) {
    await prisma.user.update({
      where: { id: existingUser.id },
      data: {
        username: 'vedora.admin',
        fullName: 'Vedora Admin',
        emailVerifiedAt: existingUser.emailVerifiedAt ?? new Date(),
        ...(existingUser.passwordHash === '!migrated-user-has-no-password'
          ? { passwordHash }
          : {}),
      },
    });
  } else {
    await prisma.user.create({
      data: {
        username: 'vedora.admin',
        passwordHash,
        email: 'admin@vedora.local',
        fullName: 'Vedora Admin',
        // admin@vedora.local can't receive mail.
        emailVerifiedAt: new Date(),
      },
    });
  }
}
