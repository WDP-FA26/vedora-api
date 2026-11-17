import type { MessageEvent } from '@nestjs/common';
import { Subject } from 'rxjs';
import { mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '../../../src/auth-core/auth.types.js';
import { UserRole } from '../../../src/mongo/models.js';
import type {
  NotificationDto,
  NotificationPageDto,
  UnreadCountDto,
} from '../../../src/notifications/dto/notification.dto.js';
import { NotificationsController } from '../../../src/notifications/notifications.controller.js';
import type { NotificationsService } from '../../../src/notifications/notifications.service.js';

describe('NotificationsController', () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const notificationId = '00000000-0000-4000-8000-000000000002';
  const request = {
    user: { sub: userId, username: 'member', role: UserRole.USER },
  } as AuthenticatedRequest;

  let service: ReturnType<typeof mockDeep<NotificationsService>>;
  let controller: NotificationsController;

  beforeEach(() => {
    service = mockDeep<NotificationsService>();
    controller = new NotificationsController(service);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams live notifications and 25s ping heartbeats, then cleans up timers', async () => {
    vi.useFakeTimers();
    const subject = new Subject<NotificationDto>();
    service.stream.mockReturnValue(subject.asObservable());

    const events: MessageEvent[] = [];
    const subscription = controller
      .stream(request)
      .subscribe((event) => events.push(event));

    expect(service.stream).toHaveBeenCalledExactlyOnceWith(userId);

    const payload = { id: notificationId } as unknown as NotificationDto;
    subject.next(payload);
    await vi.advanceTimersByTimeAsync(25_000);

    expect(events).toEqual([
      { type: 'notification', data: payload },
      { type: 'ping', data: {} },
    ]);

    subscription.unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('delegates list, unreadCount, markAllRead, and markRead to NotificationsService', async () => {
    const page = { items: [], nextCursor: null } as NotificationPageDto;
    const unread: UnreadCountDto = { unreadCount: 4 };
    service.list.mockResolvedValue(page);
    service.unreadCount.mockResolvedValue(unread);
    service.markAllRead.mockResolvedValue(undefined);
    service.markRead.mockResolvedValue(undefined);

    const query = { limit: 15, cursor: notificationId };
    await expect(controller.list(request, query)).resolves.toBe(page);
    expect(service.list).toHaveBeenCalledExactlyOnceWith(userId, query);

    await expect(controller.unreadCount(request)).resolves.toBe(unread);
    expect(service.unreadCount).toHaveBeenCalledExactlyOnceWith(userId);

    await expect(controller.markAllRead(request)).resolves.toBeUndefined();
    expect(service.markAllRead).toHaveBeenCalledExactlyOnceWith(userId);

    await expect(
      controller.markRead(notificationId, request),
    ).resolves.toBeUndefined();
    expect(service.markRead).toHaveBeenCalledExactlyOnceWith(
      userId,
      notificationId,
    );
  });
});
