import { PrismaClient } from '@prisma/client';
import { seedDatabase } from './seed';
import { seedCatalog } from './seed-catalog';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await seedDatabase(prisma);
  await seedCatalog(prisma);
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
