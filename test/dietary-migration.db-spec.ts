import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';

describe('Dietary migration from existing data', () => {
  it('preserves old exclusions and liked ingredients without inferring allergy/safety claims', async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error(
        'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
      );
    const schema =
      'vedora_dietary_migration_' + randomUUID().replaceAll('-', '');
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('schema', schema);
    const directory = mkdtempSync(join(tmpdir(), 'vedora-dietary-migration-'));
    const previousSchema = join(directory, 'schema.prisma');
    writeFileSync(
      previousSchema,
      'datasource db {\n provider = "postgresql"\n url = env("DATABASE_URL")\n}\n',
    );
    mkdirSync(join(directory, 'migrations'));
    for (const name of readdirSync(join(process.cwd(), 'prisma/migrations'))) {
      if (name !== '20261012010000_dietary_profile')
        cpSync(
          join(process.cwd(), 'prisma/migrations', name),
          join(directory, 'migrations', name),
          { recursive: true },
        );
    }
    const deploy = (schemaPath: string) =>
      execFileSync(
        process.execPath,
        [
          join(process.cwd(), 'node_modules/prisma/build/index.js'),
          'migrate',
          'deploy',
          '--schema',
          schemaPath,
        ],
        {
          env: { ...process.env, DATABASE_URL: url.toString() },
          stdio: 'pipe',
          timeout: 45_000,
        },
      );
    const prisma = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      deploy(previousSchema);
      const userId = randomUUID();
      const ingredientId = randomUUID();
      const groupId = randomUUID();
      await prisma.$executeRaw`INSERT INTO users (id, username, full_name, email, "updatedAt") VALUES (${userId}::uuid, 'legacy.dietary', 'Legacy User', 'legacy@example.test', NOW())`;
      await prisma.$executeRaw`INSERT INTO ingredients (id, name, aliases, updated_at) VALUES (${ingredientId}::uuid, 'Legacy Ingredient', ARRAY[]::varchar[], NOW())`;
      await prisma.$executeRaw`INSERT INTO ingredient_groups (id, name, updated_at) VALUES (${groupId}::uuid, 'Legacy Group', NOW())`;
      await prisma.$executeRaw`INSERT INTO user_avoided_ingredients (user_id, ingredient_id) VALUES (${userId}::uuid, ${ingredientId}::uuid)`;
      await prisma.$executeRaw`INSERT INTO user_avoided_groups (user_id, group_id) VALUES (${userId}::uuid, ${groupId}::uuid)`;
      await prisma.$executeRaw`INSERT INTO user_liked_ingredients (user_id, ingredient_id) VALUES (${userId}::uuid, ${ingredientId}::uuid)`;
      deploy(resolve('prisma/schema.prisma'));
      expect(await prisma.userAvoidedIngredient.findMany()).toEqual([
        { userId, ingredientId, reason: 'PERSONAL' },
      ]);
      expect(await prisma.userAvoidedGroup.findMany()).toEqual([
        { userId, groupId, reason: 'PERSONAL' },
      ]);
      expect(await prisma.userLikedIngredient.count()).toBe(1);
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      ).toMatchObject({
        dietMode: 'VEGETARIAN',
        allergyAcknowledgement: 'UNCONFIRMED',
        dietaryVersion: 0,
      });
      expect(
        await prisma.ingredient.findUniqueOrThrow({
          where: { id: ingredientId },
        }),
      ).toMatchObject({
        vegetarianStatus: 'UNKNOWN',
        veganStatus: 'UNKNOWN',
        allergensComplete: false,
        compositionComplete: false,
        safetyVersion: 1,
      });
    } finally {
      await prisma.$executeRaw(
        Prisma.sql`DROP SCHEMA IF EXISTS ${Prisma.raw('"' + schema + '"')} CASCADE`,
      );
      await prisma.$disconnect();
      // The mkdtemp-created directory is verified before recursive cleanup.
      if (resolve(directory).startsWith(resolve(tmpdir()) + sep))
        rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
