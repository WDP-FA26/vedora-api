import 'dotenv/config';
import mongoose from 'mongoose';
import { registerModels } from '../mongo/schemas';
import { MongoService } from '../mongo/mongo.service';
import { seedDatabase } from './seed';
import { seedCatalog } from './seed-catalog';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  const connection = mongoose.createConnection(url);
  registerModels(connection);
  try {
    const mongo = new MongoService(connection);
    await seedDatabase(mongo);
    await seedCatalog(mongo);
    console.log('Production seed completed successfully.');
  } finally {
    await connection.close();
  }
}

void main().catch((error: unknown) => {
  console.error('Production seed failed.', error);
  process.exitCode = 1;
});
