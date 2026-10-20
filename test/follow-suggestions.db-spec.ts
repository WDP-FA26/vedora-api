import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { FollowSuggestionsService } from '../src/profiles/follow-suggestions.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Follow suggestions with PostgreSQL', () => {
  const schema = `vedora_suggest_test_${randomUUID().replaceAll('-', '')}`;
  let prisma: PrismaClient;
  let service: FollowSuggestionsService;
  const ids: Record<string, string> = {};

  const follow = (from: string, to: string) =>
    prisma.follow.create({
      data: { followerId: ids[from], followingId: ids[to] },
    });

  beforeAll(async () => {
    const base = process.env.TEST_DATABASE_URL;
    if (!base)
      throw new Error(
        'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
      );
    const url = new URL(base);
    url.searchParams.set('schema', schema);
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
      ],
      {
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: 'pipe',
        timeout: 45_000,
      },
    );
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    service = new FollowSuggestionsService(prisma as PrismaService);

    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'loner', 'unverified']) {
      const user = await prisma.user.create({
        data: {
          username: `suggest.${name}`,
          fullName: name,
          email: `suggest.${name}@example.test`,
          emailVerifiedAt: name === 'unverified' ? null : new Date(),
        },
      });
      ids[name] = user.id;
    }
    // a follows b and c; they follow d (twice), f and an unverified account;
    // e follows a.
    await follow('a', 'b');
    await follow('a', 'c');
    await follow('b', 'd');
    await follow('c', 'd');
    await follow('c', 'f');
    await follow('b', 'unverified');
    await follow('e', 'a');
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$disconnect();
  });

  it('ranks follow-backs first, then by mutual followings, skipping known and unverified users', async () => {
    await service.rebuild(Object.values(ids));

    const { items } = await service.list(ids.a, 10);
    expect(items.map((i) => [i.id, i.reason, i.mutualCount])).toEqual([
      [ids.e, 'FOLLOWS_YOU', 0],
      [ids.d, 'MUTUAL', 2],
      [ids.f, 'MUTUAL', 1],
    ]);
  });

  it('drops people followed since the last rebuild', async () => {
    await follow('a', 'd');
    const { items } = await service.list(ids.a, 10);
    expect(items.map((i) => i.id)).toEqual([ids.e, ids.f]);
  });

  it('never suggests a dismissed profile again', async () => {
    await service.dismiss(ids.a, ids.f);
    expect((await service.list(ids.a, 10)).items.map((i) => i.id)).toEqual([
      ids.e,
    ]);

    await service.rebuild([ids.a]);
    expect((await service.list(ids.a, 10)).items.map((i) => i.id)).toEqual([
      ids.e,
    ]);
  });

  it('suggests nothing to a user with no graph and no active authors', async () => {
    await service.rebuild([ids.loner]);
    expect((await service.list(ids.loner, 10)).items).toEqual([]);
  });
});
