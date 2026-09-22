import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seedDatabase } from '../src/database/seed';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await seedDatabase(prisma);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
