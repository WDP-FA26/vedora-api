import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

const USER_ID = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const OTHER_ID = 'a6ff1292-ed03-4c34-a9cf-b4c7a27cbd82';

describe('Profiles and follows (e2e)', () => {
  const prisma = mockDeep<PrismaService>();
  let app: INestApplication<App>;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    token = await app.get(JwtService).signAsync({
      sub: USER_ID,
      username: 'vedora.user',
    });
  });

  beforeEach(() => {
    mockReset(prisma);
    prisma.user.findUnique.mockImplementation(
      ({ where }) =>
        Promise.resolve({
          id: where.id ?? OTHER_ID,
          username: 'vedora.user',
          fullName: 'Vedora User',
          role: UserRole.USER,
          emailVerifiedAt: new Date(),
          bio: null,
          avatarUrl: null,
          coverUrl: null,
          createdAt: new Date('2026-09-29T00:00:00Z'),
          email: 'private@vedora.vn',
        }) as never,
    );
    prisma.post.count.mockResolvedValue(2);
    prisma.follow.count.mockResolvedValue(1);
    prisma.follow.findMany.mockResolvedValue([]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves public profiles without private account data', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/profiles/${OTHER_ID}`)
      .expect(200);
    expect(response.body).toMatchObject({
      id: OTHER_ID,
      postCount: 2,
      followerCount: 1,
      followingCount: 1,
    });
    expect(response.body).not.toHaveProperty('email');
    expect(response.body).not.toHaveProperty('role');
  });

  it('keeps follow mutations private and rejects self-follow', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/profiles/${OTHER_ID}/follow`)
      .expect(401);
    await request(app.getHttpServer())
      .put(`/api/v1/profiles/${USER_ID}/follow`)
      .auth(token, { type: 'bearer' })
      .expect(400);
    await request(app.getHttpServer())
      .put(`/api/v1/profiles/${OTHER_ID}/follow`)
      .auth(token, { type: 'bearer' })
      .expect(204);
    expect(prisma.follow.createMany).toHaveBeenCalledWith({
      data: [{ followerId: USER_ID, followingId: OTHER_ID }],
      skipDuplicates: true,
    });
  });

  it('exposes follower lists and published posts to guests', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/profiles/${OTHER_ID}/followers`)
      .expect(200, { items: [], nextCursor: null });
    prisma.post.findMany.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get(`/api/v1/posts?authorId=${OTHER_ID}`)
      .expect(200, { items: [], nextCursor: null });
  });

  it('validates profile edits and never accepts a client-supplied image URL', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/profiles/me')
      .auth(token, { type: 'bearer' })
      .send({ avatarUrl: 'https://example.com/forged.png' })
      .expect(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
