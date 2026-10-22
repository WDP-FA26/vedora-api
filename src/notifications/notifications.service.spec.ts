import { NotificationType } from '@prisma/client';
import { type DeepMockProxy, mockDeep } from 'vitest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

const recipientId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
const actorId = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
const postId = 'b7f6f651-b0fc-43a5-b589-edbda60e5983';
const row = {
  id: '8f2f5b5e-6a53-4c2a-9a0e-1b6a3a5c9d11',
  recipientId,
  type: NotificationType.LIKE,
  postId,
  commentId: null,
  readAt: null,
  createdAt: new Date('2026-10-19T08:00:00Z'),
  actor: { id: actorId, username: 'a', fullName: 'A', avatarUrl: null },
};

describe('NotificationsService', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: NotificationsService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new NotificationsService(prisma);
  });

  it('stores a notification and pushes it only to its recipient', async () => {
    prisma.notification.findFirst.mockResolvedValue(null);
    prisma.notification.create.mockResolvedValue(row as never);
    const mine: unknown[] = [];
    const others: unknown[] = [];
    service.stream(recipientId).subscribe((n) => mine.push(n));
    service.stream(actorId).subscribe((n) => others.push(n));

    await service.notify({
      recipientId,
      actorId,
      type: NotificationType.LIKE,
      postId,
    });

    expect(mine).toHaveLength(1);
    expect(mine[0]).not.toHaveProperty('recipientId');
    expect(others).toHaveLength(0);
  });

  it('ignores self-notifications and repeated likes', async () => {
    await service.notify({
      recipientId,
      actorId: recipientId,
      type: NotificationType.LIKE,
      postId,
    });
    prisma.notification.findFirst.mockResolvedValue({ id: row.id } as never);
    await service.notify({
      recipientId,
      actorId,
      type: NotificationType.LIKE,
      postId,
    });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('never throws when storing fails', async () => {
    prisma.notification.findFirst.mockResolvedValue(null);
    prisma.notification.create.mockRejectedValue(new Error('db down'));
    await expect(
      service.notify({
        recipientId,
        actorId,
        type: NotificationType.FOLLOW,
      }),
    ).resolves.toBeUndefined();
  });

  it('marks only the caller’s unread notifications as read', async () => {
    await service.markRead(recipientId, row.id);
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: row.id, recipientId, readAt: null },
      data: { readAt: expect.any(Date) as Date },
    });
  });
});
