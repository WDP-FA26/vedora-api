import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountStatus,
  Prisma,
  User,
  UserAccountAction,
  UserRole,
} from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { assertAccountActive } from '../auth/account-access';
import { hashPassword } from '../auth/password';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UsersQueryDto } from './dto/users-query.dto';

export const publicUserSelect = {
  id: true,
  username: true,
  fullName: true,
  email: true,
  role: true,
  status: true,
  accountVersion: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{
  select: typeof publicUserSelect;
}>;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.UserCreateInput): Promise<PublicUser> {
    try {
      return await this.prisma.user.create({
        data,
        select: publicUserSelect,
      });
    } catch (error: unknown) {
      this.rethrowKnownError(error);
    }
  }

  async createWithPassword(dto: CreateUserDto): Promise<PublicUser> {
    const passwordHash = await hashPassword(dto.password);
    return this.create({
      username: dto.username,
      passwordHash,
      fullName: dto.fullName,
      email: dto.email,
    });
  }

  async findAll(
    query: UsersQueryDto,
  ): Promise<PaginatedResponseDto<PublicUser>> {
    const where: Prisma.UserWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: ['username', 'fullName', 'email'].map((field) => ({
              [field]: {
                contains: query.q,
                mode: Prisma.QueryMode.insensitive,
              },
            })),
          }
        : {}),
    };
    // Count and rows use one snapshot so concurrent writes cannot disagree.
    const [items, totalItems] = await this.prisma.$transaction(
      [
        this.prisma.user.findMany({
          where,
          select: publicUserSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          ...getPaginationArgs(query),
        }),
        this.prisma.user.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return createPaginatedResponse(items, totalItems, query);
  }

  async findOne(id: string, actor: AuthenticatedUser): Promise<PublicUser> {
    this.assertCanAccess(id, actor);
    const user = await this.findPublicById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    actor: AuthenticatedUser,
  ): Promise<PublicUser> {
    this.assertCanAccess(id, actor);
    try {
      return await this.prisma.user.update({
        where: { id },
        // Explicit fields keep account permissions out of profile updates.
        data: {
          username: dto.username,
          fullName: dto.fullName,
          email: dto.email,
        },
        select: publicUserSelect,
      });
    } catch (error: unknown) {
      this.rethrowKnownError(error);
    }
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    this.assertCanAccess(id, actor);
    try {
      await this.withAccountGate(id, actor, false, async (tx, target) => {
        await this.assertNotLastAdmin(tx, target);
        await this.writeAudit(
          tx,
          actor.sub,
          target,
          UserAccountAction.DELETE,
          'Account deletion requested',
          AccountStatus.DELETED,
          target.role,
        );
        await tx.user.delete({ where: { id } });
      });
    } catch (error: unknown) {
      this.rethrowKnownError(error);
    }
  }

  findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { username } });
  }

  async updateRole(
    id: string,
    dto: UpdateUserRoleDto,
    actor: AuthenticatedUser,
  ): Promise<PublicUser> {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only admins can change user roles');
    }
    try {
      return await this.withAccountGate(id, actor, true, async (tx, target) => {
        this.assertVersion(target, dto.expectedVersion);
        if (target.role === dto.role) return this.selectPublic(target);
        if (dto.role !== UserRole.ADMIN)
          await this.assertNotLastAdmin(tx, target);
        const updated = await tx.user.update({
          where: { id },
          data: { role: dto.role, accountVersion: { increment: 1 } },
          select: publicUserSelect,
        });
        await this.writeAudit(
          tx,
          actor.sub,
          target,
          UserAccountAction.ROLE_CHANGE,
          dto.reason,
          target.status,
          dto.role,
        );
        return updated;
      });
    } catch (error: unknown) {
      this.rethrowKnownError(error);
    }
  }

  async updateStatus(
    id: string,
    dto: UpdateUserStatusDto,
    actor: AuthenticatedUser,
  ): Promise<PublicUser> {
    if (actor.role !== UserRole.ADMIN)
      throw new ForbiddenException('Only admins can change account status');
    return this.withAccountGate(id, actor, true, async (tx, target) => {
      this.assertVersion(target, dto.expectedVersion);
      if (target.status === dto.status) return this.selectPublic(target);
      if (
        (target.status !== AccountStatus.ACTIVE &&
          target.status !== AccountStatus.SUSPENDED) ||
        (dto.status === AccountStatus.ACTIVE && !target.emailVerifiedAt)
      ) {
        throw new ConflictException({
          code: 'INVALID_ACCOUNT_TRANSITION',
          message:
            'Only verified ACTIVE/SUSPENDED accounts can be suspended or reactivated',
        });
      }
      if (dto.status === AccountStatus.SUSPENDED)
        await this.assertNotLastAdmin(tx, target);
      const updated = await tx.user.update({
        where: { id },
        data: { status: dto.status, accountVersion: { increment: 1 } },
        select: publicUserSelect,
      });
      await this.writeAudit(
        tx,
        actor.sub,
        target,
        dto.status === AccountStatus.SUSPENDED
          ? UserAccountAction.SUSPEND
          : UserAccountAction.REACTIVATE,
        dto.reason,
        dto.status,
        target.role,
      );
      return updated;
    });
  }

  findByGoogleId(googleId: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { googleId } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  /**
   * Links Google to an existing account with the same email. If that account
   * never verified its email, anyone could have registered it, so its password
   * is removed and Google's verification takes over.
   */
  async linkGoogleAccount(user: User, googleId: string): Promise<PublicUser> {
    try {
      return await this.prisma.user.update({
        where: {
          id: user.id,
          status: { in: [AccountStatus.ACTIVE, AccountStatus.PENDING_EMAIL] },
        },
        data: user.emailVerifiedAt
          ? { googleId, status: AccountStatus.ACTIVE }
          : {
              googleId,
              passwordHash: null,
              emailVerifiedAt: new Date(),
              status: AccountStatus.ACTIVE,
            },
        select: publicUserSelect,
      });
    } catch (error: unknown) {
      this.rethrowKnownError(error);
    }
  }

  /**
   * Frees an email or username held by a password account that was never
   * verified and is older than `createdBefore`, so nobody can squat on an
   * address they don't own.
   */
  async deleteStaleUnverified(
    { email, username }: { email: string; username: string },
    createdBefore: Date,
  ): Promise<void> {
    await this.prisma.user.deleteMany({
      where: {
        OR: [{ email }, { username }],
        emailVerifiedAt: null,
        googleId: null,
        role: UserRole.USER,
        status: AccountStatus.PENDING_EMAIL,
        createdAt: { lt: createdBefore },
      },
    });
  }

  findPublicById(id: string): Promise<PublicUser | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: publicUserSelect,
    });
  }

  private assertCanAccess(id: string, actor: AuthenticatedUser): void {
    if (actor.role !== UserRole.ADMIN && actor.sub !== id) {
      throw new ForbiddenException('You can only access your own account');
    }
  }

  private selectPublic(user: User): PublicUser {
    const {
      id,
      username,
      fullName,
      email,
      role,
      status,
      accountVersion,
      createdAt,
      updatedAt,
    } = user;
    return {
      id,
      username,
      fullName,
      email,
      role,
      status,
      accountVersion,
      createdAt,
      updatedAt,
    };
  }

  private assertVersion(target: User, expectedVersion: number): void {
    if (target.accountVersion !== expectedVersion) {
      throw new ConflictException({
        code: 'ACCOUNT_VERSION_CONFLICT',
        message: 'Account changed; reload it before retrying',
      });
    }
  }

  private async assertNotLastAdmin(
    tx: Prisma.TransactionClient,
    target: User,
  ): Promise<void> {
    if (
      target.role !== UserRole.ADMIN ||
      target.status !== AccountStatus.ACTIVE
    )
      return;
    const activeAdmins = await tx.user.count({
      where: { role: UserRole.ADMIN, status: AccountStatus.ACTIVE },
    });
    if (activeAdmins <= 1) {
      throw new ConflictException({
        code: 'LAST_ACTIVE_ADMIN',
        message: 'At least one ACTIVE admin must remain',
      });
    }
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    actorId: string,
    target: User,
    action: UserAccountAction,
    reason: string,
    status: AccountStatus,
    role: UserRole,
  ): Promise<void> {
    await tx.userAccountAudit.create({
      data: {
        actorId,
        userId: target.id,
        action,
        reason,
        previousStatus: target.status,
        status,
        previousRole: target.role,
        role,
        accountVersion: target.accountVersion + 1,
      },
    });
  }

  private withAccountGate<T>(
    id: string,
    actor: AuthenticatedUser,
    adminOnly: boolean,
    operation: (tx: Prisma.TransactionClient, target: User) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // One transaction-scoped gate serializes all role/status/deletion paths,
      // including changes to different admins. Per-account locks also order
      // these changes against refresh-token issuance.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(742019, 1)`;
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid OR id = ${actor.sub}::uuid ORDER BY id FOR UPDATE`;
      const currentActor = await tx.user.findUnique({
        where: { id: actor.sub },
      });
      if (!currentActor)
        throw new ForbiddenException('Account no longer exists');
      assertAccountActive(currentActor.status);
      if (
        (adminOnly || id !== actor.sub) &&
        currentActor.role !== UserRole.ADMIN
      ) {
        throw new ForbiddenException('Only admins can manage another account');
      }
      const target = await tx.user.findUnique({ where: { id } });
      if (!target || target.status === AccountStatus.DELETED)
        throw new NotFoundException('User not found');
      return operation(tx, target);
    });
  }

  private rethrowKnownError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        const fields = Array.isArray(error.meta?.target)
          ? error.meta.target.join(', ')
          : 'Username or email';
        throw new ConflictException(`${fields} already exists`);
      }
      if (error.code === 'P2025') {
        throw new NotFoundException('User not found');
      }
    }
    throw error;
  }
}
