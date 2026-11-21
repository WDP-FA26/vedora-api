import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import type { ClientSession, Model, QueryFilter } from 'mongoose';
import { assertAccountActive } from '../auth-core/account-access.js';
import type { AuthenticatedUser } from '../auth-core/auth.types.js';
import { ProfileSearchIndexService } from '../profiles/search/profile-search-index.service.js';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../common/pagination/index.js';
import { escapeRegExp } from '../common/text.js';
import { lockDocument } from '../mongo/document-lock.js';
import {
  AccountStatus,
  AccountType,
  User,
  UserAccountAction,
  UserAccountAudit,
  UserRole,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { AccountsService, HUMAN_ACCOUNT } from './accounts.service.js';
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
import { AccessDeniedException } from '../common/exceptions/access-denied.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(UserAccountAudit.name)
    private readonly audits: Model<UserAccountAudit>,
    private readonly mongo: MongoService,
    private readonly accounts: AccountsService,
    @Optional() private readonly profileSearchIndex?: ProfileSearchIndexService,
  ) {}

  async findAll(
    query: UsersQueryDto,
  ): Promise<PaginatedResponseDto<PublicUser>> {
    const filters: QueryFilter<User>[] = [HUMAN_ACCOUNT];
    if (query.status) filters.push({ status: query.status });
    if (query.q) {
      const pattern = { $regex: escapeRegExp(query.q), $options: 'i' };
      filters.push({
        $or: ['username', 'fullName', 'email'].map((field) => ({
          [field]: pattern,
        })),
      });
    }
    const filter: QueryFilter<User> = { $and: filters };
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
    if (!user)
      throw new ResourceNotFoundException('NOT_FOUND', 'User not found');
    return user;
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    actor: AuthenticatedUser,
  ): Promise<PublicUser> {
    this.assertCanAccess(id, actor);
    try {
      const hasSearchField =
        dto.username !== undefined || dto.fullName !== undefined;
      const user = await this.users
        .findOneAndUpdate(
          { _id: id, ...HUMAN_ACCOUNT },
          {
            $set: {
              ...(dto.username !== undefined && { username: dto.username }),
              ...(dto.fullName !== undefined && { fullName: dto.fullName }),
              ...(hasSearchField && { searchIndexedAt: null }),
            },
          },
          { returnDocument: 'after' },
        )
        .exec();
      if (!user)
        throw new ResourceNotFoundException('NOT_FOUND', 'User not found');
      if (hasSearchField) this.profileSearchIndex?.schedule();
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
      await this.profileSearchIndex?.remove(id);
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
      throw new AccessDeniedException(
        'FORBIDDEN',
        'Only admins can change user roles',
      );
    }
    try {
      return await this.withAccountGate(
        id,
        actor,
        true,
        async (target, session) => {
          this.assertVersion(target, dto.expectedVersion);
          if (target.role === dto.role) return toPublicUser(target);
          // Every manager acts as the page, so a page must never be an admin.
          if (
            dto.role === UserRole.ADMIN &&
            target.accountType === AccountType.PAGE
          )
            throw new StateConflictException(
              'INVALID_ACCOUNT_TRANSITION',
              'A restaurant page cannot be an admin',
            );
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
      throw new AccessDeniedException(
        'FORBIDDEN',
        'Only admins can change account status',
      );
    const updated = await this.withAccountGate(
      id,
      actor,
      true,
      async (target, session) => {
        this.assertVersion(target, dto.expectedVersion);
        if (target.status === dto.status) return toPublicUser(target);
        if (
          (target.status !== AccountStatus.ACTIVE &&
            target.status !== AccountStatus.SUSPENDED) ||
          (dto.status === AccountStatus.ACTIVE && !target.emailVerifiedAt)
        ) {
          throw new StateConflictException(
            'INVALID_ACCOUNT_TRANSITION',
            'Only verified ACTIVE/SUSPENDED accounts can be suspended or reactivated',
          );
        }
        if (dto.status === AccountStatus.SUSPENDED)
          await this.assertNotLastAdmin(target, session);
        const changed = await this.changeAccount(session, target, {
          status: dto.status,
          searchIndexedAt: null,
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
        return changed;
      },
    );
    if (dto.status === AccountStatus.SUSPENDED) {
      await this.profileSearchIndex?.remove(id);
    } else if (dto.status === AccountStatus.ACTIVE) {
      this.profileSearchIndex?.schedule();
    }
    return updated;
  }

  private assertCanAccess(id: string, actor: AuthenticatedUser): void {
    if (actor.role !== UserRole.ADMIN && actor.sub !== id) {
      throw new AccessDeniedException(
        'FORBIDDEN',
        'You can only access your own account',
      );
    }
  }

  private assertVersion(target: User, expectedVersion: number): void {
    if (target.accountVersion !== expectedVersion) {
      throw new StateConflictException(
        'ACCOUNT_VERSION_CONFLICT',
        'Account changed; reload it before retrying',
      );
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
      throw new StateConflictException(
        'LAST_ACTIVE_ADMIN',
        'At least one ACTIVE admin must remain',
      );
    }
  }

  private async changeAccount(
    session: ClientSession,
    target: User,
    change: Partial<Pick<User, 'role' | 'status' | 'searchIndexedAt'>>,
  ): Promise<PublicUser> {
    const updated = await this.users
      .findOneAndUpdate(
        { _id: target.id },
        { $set: change, $inc: { accountVersion: 1 } },
        { session, returnDocument: 'after' },
      )
      .exec();
    if (!updated)
      throw new ResourceNotFoundException('NOT_FOUND', 'User not found');
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
      await lockDocument(this.mongo, session, 'account-gate');
      for (const lockId of [...new Set([id, actor.sub])].sort()) {
        await lockDocument(this.mongo, session, 'user', lockId);
      }
      const currentActor = await this.findUser(actor.sub, session);
      if (!currentActor)
        throw new AccessDeniedException(
          'FORBIDDEN',
          'Account no longer exists',
        );
      assertAccountActive(currentActor.status);
      if (
        (adminOnly || id !== actor.sub) &&
        currentActor.role !== UserRole.ADMIN
      ) {
        throw new AccessDeniedException(
          'FORBIDDEN',
          'Only admins can manage another account',
        );
      }
      const target = await this.findUser(id, session);
      if (
        !target ||
        target.status === AccountStatus.DELETED ||
        target.status === AccountStatus.SYSTEM
      )
        throw new ResourceNotFoundException('NOT_FOUND', 'User not found');
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
