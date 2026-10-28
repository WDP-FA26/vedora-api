import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model, QueryFilter } from 'mongoose';
import { assertAccountActive } from '../auth/account-access.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../common/pagination/index.js';
import { escapeRegExp } from '../common/text.js';
import { lockDocument } from '../mongo/document-lock.js';
import {
  AccountStatus,
  User,
  UserAccountAction,
  UserAccountAudit,
  UserRole,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { AccountsService } from './accounts.service.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { UpdateUserRoleDto } from './dto/update-user-role.dto.js';
import { UpdateUserStatusDto } from './dto/update-user-status.dto.js';
import { UsersQueryDto } from './dto/users-query.dto.js';
import {
  type PublicUser,
  publicUserProjection,
  toPublicUser,
} from './public-user.js';
import { rethrowUniqueViolation } from './unique-conflict.js';

/**
 * Self-service and admin management of accounts: reading one, editing its
 * profile, changing roles and status, and deleting it. Every operation goes
 * through `withAccountGate`, which decides whether the actor may act.
 */
@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(UserAccountAudit.name)
    private readonly audits: Model<UserAccountAudit>,
    private readonly mongo: MongoService,
    private readonly accounts: AccountsService,
  ) {}

  async findAll(
    query: UsersQueryDto,
  ): Promise<PaginatedResponseDto<PublicUser>> {
    const filters: QueryFilter<User>[] = [];
    if (query.status) filters.push({ status: query.status });
    if (query.q) {
      // Case-insensitive match on any of the identifying fields.
      const pattern = { $regex: escapeRegExp(query.q), $options: 'i' };
      filters.push({
        $or: ['username', 'fullName', 'email'].map((field) => ({
          [field]: pattern,
        })),
      });
    }
    const filter: QueryFilter<User> =
      filters.length === 0
        ? {}
        : filters.length === 1
          ? filters[0]
          : { $and: filters };
    const { skip, take } = getPaginationArgs(query);
    const [items, totalItems] = await Promise.all([
      this.users
        .find(filter)
        .select(publicUserProjection)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(take)
        .exec(),
      this.users.countDocuments(filter),
    ]);
    return createPaginatedResponse(
      items.map((user) => toPublicUser(user)),
      totalItems,
      query,
    );
  }

  async findOne(id: string, actor: AuthenticatedUser): Promise<PublicUser> {
    this.assertCanAccess(id, actor);
    const user = await this.accounts.findPublicById(id);
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
      const user = await this.users
        .findOneAndUpdate(
          { _id: id },
          {
            // Explicit fields keep account permissions out of profile updates.
            $set: {
              ...(dto.username !== undefined && { username: dto.username }),
              ...(dto.fullName !== undefined && { fullName: dto.fullName }),
              ...(dto.email !== undefined && { email: dto.email }),
            },
          },
          { returnDocument: 'after' },
        )
        .exec();
      if (!user) throw new NotFoundException('User not found');
      return toPublicUser(user);
    } catch (error: unknown) {
      rethrowUniqueViolation(error);
    }
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    this.assertCanAccess(id, actor);
    try {
      await this.withAccountGate(id, actor, false, async (target, session) => {
        await this.assertNotLastAdmin(target, session);
        await this.writeAudit(
          session,
          actor.sub,
          target,
          UserAccountAction.DELETE,
          'Account deletion requested',
          AccountStatus.DELETED,
          target.role,
        );
        await this.users.deleteOne({ _id: id }, { session }).exec();
      });
    } catch (error: unknown) {
      rethrowUniqueViolation(error);
    }
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
      return await this.withAccountGate(
        id,
        actor,
        true,
        async (target, session) => {
          this.assertVersion(target, dto.expectedVersion);
          if (target.role === dto.role) return toPublicUser(target);
          if (dto.role !== UserRole.ADMIN) {
            await this.assertNotLastAdmin(target, session);
          }
          const updated = await this.changeAccount(session, target, {
            role: dto.role,
          });
          await this.writeAudit(
            session,
            actor.sub,
            target,
            UserAccountAction.ROLE_CHANGE,
            dto.reason,
            target.status,
            dto.role,
          );
          return updated;
        },
      );
    } catch (error: unknown) {
      rethrowUniqueViolation(error);
    }
  }

  async updateStatus(
    id: string,
    dto: UpdateUserStatusDto,
    actor: AuthenticatedUser,
  ): Promise<PublicUser> {
    if (actor.role !== UserRole.ADMIN)
      throw new ForbiddenException('Only admins can change account status');
    return this.withAccountGate(id, actor, true, async (target, session) => {
      this.assertVersion(target, dto.expectedVersion);
      if (target.status === dto.status) return toPublicUser(target);
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
        await this.assertNotLastAdmin(target, session);
      const updated = await this.changeAccount(session, target, {
        status: dto.status,
      });
      await this.writeAudit(
        session,
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

  private assertCanAccess(id: string, actor: AuthenticatedUser): void {
    if (actor.role !== UserRole.ADMIN && actor.sub !== id) {
      throw new ForbiddenException('You can only access your own account');
    }
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
    target: User,
    session: ClientSession,
  ): Promise<void> {
    if (
      target.role !== UserRole.ADMIN ||
      target.status !== AccountStatus.ACTIVE
    )
      return;
    const activeAdmins = await this.users.countDocuments(
      { role: UserRole.ADMIN, status: AccountStatus.ACTIVE },
      { session },
    );
    if (activeAdmins <= 1) {
      throw new ConflictException({
        code: 'LAST_ACTIVE_ADMIN',
        message: 'At least one ACTIVE admin must remain',
      });
    }
  }

  /** Sets a role or status and moves the account to its next version. */
  private async changeAccount(
    session: ClientSession,
    target: User,
    change: Partial<Pick<User, 'role' | 'status'>>,
  ): Promise<PublicUser> {
    const updated = await this.users
      .findOneAndUpdate(
        { _id: target.id },
        { $set: change, $inc: { accountVersion: 1 } },
        { session, returnDocument: 'after' },
      )
      .exec();
    if (!updated) throw new NotFoundException('User not found');
    return toPublicUser(updated);
  }

  private async writeAudit(
    session: ClientSession,
    actorId: string,
    target: User,
    action: UserAccountAction,
    reason: string,
    status: AccountStatus,
    role: UserRole,
  ): Promise<void> {
    await this.audits.create(
      [
        {
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
      ],
      { session },
    );
  }

  private withAccountGate<T>(
    id: string,
    actor: AuthenticatedUser,
    adminOnly: boolean,
    operation: (target: User, session: ClientSession) => Promise<T>,
  ): Promise<T> {
    return this.mongo.withTransaction(async (session) => {
      // One gate serializes all role/status/deletion paths, including
      // changes to different admins. Per-account locks also order these
      // changes against refresh-token issuance. Locks are taken in a fixed
      // order.
      await lockDocument(this.mongo, session, 'account-gate');
      for (const lockId of [...new Set([id, actor.sub])].sort()) {
        await lockDocument(this.mongo, session, 'user', lockId);
      }
      const currentActor = await this.findUser(actor.sub, session);
      if (!currentActor)
        throw new ForbiddenException('Account no longer exists');
      assertAccountActive(currentActor.status);
      if (
        (adminOnly || id !== actor.sub) &&
        currentActor.role !== UserRole.ADMIN
      ) {
        throw new ForbiddenException('Only admins can manage another account');
      }
      const target = await this.findUser(id, session);
      if (!target || target.status === AccountStatus.DELETED)
        throw new NotFoundException('User not found');
      return operation(target, session);
    });
  }

  private async findUser(
    id: string,
    session: ClientSession,
  ): Promise<User | null> {
    return this.users.findOne({ _id: id }).session(session).exec();
  }
}
