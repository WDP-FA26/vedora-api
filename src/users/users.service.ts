import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { hashPassword } from '../auth/password';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

export const publicUserSelect = {
  id: true,
  username: true,
  fullName: true,
  email: true,
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

  findAll(): Promise<PublicUser[]> {
    return this.prisma.user.findMany({
      select: publicUserSelect,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string): Promise<PublicUser> {
    const user = await this.findPublicById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async update(id: string, dto: UpdateUserDto): Promise<PublicUser> {
    try {
      return await this.prisma.user.update({
        where: { id },
        data: dto,
        select: publicUserSelect,
      });
    } catch (error: unknown) {
      this.rethrowKnownError(error);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.prisma.user.delete({ where: { id } });
    } catch (error: unknown) {
      this.rethrowKnownError(error);
    }
  }

  findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { username } });
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
