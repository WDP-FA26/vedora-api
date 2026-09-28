import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, User, UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { hashPassword } from '../auth/password';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
  PaginationQueryDto,
} from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

export const publicUserSelect = {
  id: true,
  username: true,
  fullName: true,
  email: true,
  role: true,
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
    query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<PublicUser>> {
    // Count and rows use one snapshot so concurrent writes cannot disagree.
    const [items, totalItems] = await this.prisma.$transaction(
      [
        this.prisma.user.findMany({
          select: publicUserSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          ...getPaginationArgs(query),
        }),
        this.prisma.user.count(),
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
      await this.prisma.user.delete({ where: { id } });
    } catch (error: unknown) {
      this.rethrowKnownError(error);
    }
  }

  findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { username } });
  }

  async updateRole(
    id: string,
    role: UserRole,
    actor: AuthenticatedUser,
  ): Promise<PublicUser> {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only admins can change user roles');
    }
    try {
      return await this.prisma.user.update({
        where: { id },
        data: { role },
        select: publicUserSelect,
      });
    } catch (error: unknown) {
      this.rethrowKnownError(error);
    }
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
        where: { id: user.id },
        data: user.emailVerifiedAt
          ? { googleId }
          : { googleId, passwordHash: null, emailVerifiedAt: new Date() },
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
