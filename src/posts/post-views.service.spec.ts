import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import { PostViewsService } from './post-views.service';

const postA = 'f1a2d3e4-0000-4000-8000-000000000001';
const postB = 'f1a2d3e4-0000-4000-8000-000000000002';
const MINUTE = 60_000;

/** The `(id, views)` pairs bound into the flush statement. */
function flushedViews(prisma: DeepMockProxy<PrismaService>, call = 0) {
  const values = prisma.$executeRaw.mock.calls[call].slice(1) as unknown[];
  const sql = values[0] as { values: unknown[] };
  const pairs: Record<string, number> = {};
  for (let index = 0; index < sql.values.length; index += 2) {
    pairs[sql.values[index] as string] = sql.values[index + 1] as number;
  }
  return pairs;
}

describe('PostViewsService', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: PostViewsService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    prisma.$executeRaw.mockResolvedValue(1);
    service = new PostViewsService(prisma);
  });

  it('writes nothing until a flush, then one statement for every post', async () => {
    service.record('user-1', [postA, postB]);
    service.record('user-2', [postA]);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();

    await service.flush();

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(flushedViews(prisma)).toEqual({ [postA]: 2, [postB]: 1 });
  });

  it('counts a viewer once per post within the dedupe window', async () => {
    service.record('user-1', [postA, postA], 0);
    service.record('user-1', [postA], 10 * MINUTE);
    await service.flush();
    expect(flushedViews(prisma)).toEqual({ [postA]: 1 });

    service.record('user-1', [postA], 31 * MINUTE);
    await service.flush();
    expect(flushedViews(prisma, 1)).toEqual({ [postA]: 1 });
  });

  it('skips the database when nothing was viewed', async () => {
    await service.flush();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('keeps the counts for the next flush when the write fails', async () => {
    prisma.$executeRaw.mockRejectedValueOnce(new Error('down'));
    service.record('user-1', [postA]);
    await service.flush();
    service.record('user-2', [postA]);
    await service.flush();

    expect(flushedViews(prisma, 1)).toEqual({ [postA]: 2 });
  });

  it('flushes what is left on shutdown', async () => {
    service.record('user-1', [postA]);
    await service.onApplicationShutdown();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
