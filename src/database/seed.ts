import { PrismaClient } from '@prisma/client';

export async function seedDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.user.upsert({
    where: { email: 'admin@vedora.local' },
    update: {},
    create: {
      email: 'admin@vedora.local',
      name: 'Vedora Admin',
    },
  });
}
