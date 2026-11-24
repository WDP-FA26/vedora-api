import { mockDeep } from 'vitest-mock-extended';
import type { AuthenticatedRequest } from '@src/auth-core/auth.types.js';
import type { PaginatedResponseDto } from '@src/common/pagination/index.js';
import { AccountStatus, UserRole } from '@src/mongo/models.js';
import type { AccountsService } from '@src/users/accounts.service.js';
import type { PublicUser } from '@src/users/public-user.js';
import { UsersController } from '@src/users/users.controller.js';
import type { UsersService } from '@src/users/users.service.js';

describe('UsersController', () => {
  const actorId = '4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2';
  const targetId = '0b8f0c1e-3c55-4c1b-9d0e-2f7f3a9f7a10';
  const actor = {
    sub: actorId,
    username: 'vedora.admin',
    role: UserRole.ADMIN,
  };
  const request = { user: actor } as AuthenticatedRequest;
  const user: PublicUser = {
    id: targetId,
    username: 'vedora.user',
    fullName: 'Vedora User',
    email: 'user@vedora.vn',
    role: UserRole.USER,
    status: AccountStatus.ACTIVE,
    accountVersion: 1,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-02T00:00:00Z'),
  };

  let usersService: ReturnType<typeof mockDeep<UsersService>>;
  let accountsService: ReturnType<typeof mockDeep<AccountsService>>;
  let controller: UsersController;

  beforeEach(() => {
    usersService = mockDeep<UsersService>();
    accountsService = mockDeep<AccountsService>();
    controller = new UsersController(usersService, accountsService);
  });

  it('delegates create() to accounts.createWithPassword', async () => {
    const dto = {
      username: 'vedora.user',
      password: 'StrongPassword123!',
      fullName: 'Vedora User',
      email: 'user@vedora.vn',
    };
    accountsService.createWithPassword.mockResolvedValue(user);

    await expect(controller.create(dto)).resolves.toBe(user);
    expect(accountsService.createWithPassword).toHaveBeenCalledExactlyOnceWith(
      dto,
    );
  });

  it('delegates findAll() to usersService.findAll', async () => {
    const query = { page: 1, limit: 20, q: 'vedora' };
    const page: PaginatedResponseDto<PublicUser> = {
      items: [user],
      meta: {
        page: 1,
        limit: 20,
        totalItems: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    };
    usersService.findAll.mockResolvedValue(page);

    await expect(controller.findAll(query)).resolves.toBe(page);
    expect(usersService.findAll).toHaveBeenCalledExactlyOnceWith(query);
  });

  it('delegates findOne() with id and authenticated actor', async () => {
    usersService.findOne.mockResolvedValue(user);

    await expect(controller.findOne(request, targetId)).resolves.toBe(user);
    expect(usersService.findOne).toHaveBeenCalledExactlyOnceWith(
      targetId,
      actor,
    );
  });

  it('delegates update() with id, dto, and authenticated actor', async () => {
    const dto = { fullName: 'Updated Name' };
    usersService.update.mockResolvedValue(user);

    await expect(controller.update(request, targetId, dto)).resolves.toBe(user);
    expect(usersService.update).toHaveBeenCalledExactlyOnceWith(
      targetId,
      dto,
      actor,
    );
  });

  it('delegates updateRole() with id, dto, and authenticated actor', async () => {
    const dto = {
      role: UserRole.ADMIN,
      expectedVersion: 0,
      reason: 'Promote moderator',
    };
    usersService.updateRole.mockResolvedValue(user);

    await expect(controller.updateRole(request, targetId, dto)).resolves.toBe(
      user,
    );
    expect(usersService.updateRole).toHaveBeenCalledExactlyOnceWith(
      targetId,
      dto,
      actor,
    );
  });

  it('delegates updateStatus() with id, dto, and authenticated actor', async () => {
    const dto = {
      status: AccountStatus.SUSPENDED,
      expectedVersion: 1,
      reason: 'Policy violation',
    };
    usersService.updateStatus.mockResolvedValue(user);

    await expect(controller.updateStatus(request, targetId, dto)).resolves.toBe(
      user,
    );
    expect(usersService.updateStatus).toHaveBeenCalledExactlyOnceWith(
      targetId,
      dto,
      actor,
    );
  });

  it('delegates remove() with id and actor and returns void', async () => {
    usersService.remove.mockResolvedValue(undefined);

    await expect(controller.remove(request, targetId)).resolves.toBeUndefined();
    expect(usersService.remove).toHaveBeenCalledExactlyOnceWith(
      targetId,
      actor,
    );
  });
});
