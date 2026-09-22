import { PrismaClient } from '@prisma/client';
import { seedDatabase } from './seed';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await seedDatabase(prisma);
  console.log('Production seed completed successfully.');
}

void main()
  .catch((error: unknown) => {
    console.error('Production seed failed.', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
