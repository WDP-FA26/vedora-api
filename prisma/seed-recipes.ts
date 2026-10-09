import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seedCatalog } from '../src/database/seed-catalog';

const prisma = new PrismaClient();

seedCatalog(prisma)
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
