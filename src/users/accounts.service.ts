import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { hashPassword } from '../auth/password';
import { AccountStatus, User, UserRole } from '../mongo/models';
import { MongoService } from '../mongo/mongo.service';
import { deleteWithReferences } from '../mongo/relations';
import { CreateUserDto } from './dto/create-user.dto';
import {
  type PublicUser,
  publicUserProjection,
  toPublicUser,
} from './public-user';
import { rethrowUniqueViolation } from './unique-conflict';

/** What a new account may set; everything else starts at its default. */
export type NewUser = Pick<User, 'username' | 'fullName' | 'email'> &
  Partial<
    Pick<User, 'passwordHash' | 'googleId' | 'emailVerifiedAt' | 'status'>
  >;

/**
 * Creates accounts and finds them by the identity auth uses (username, email
 * or Google id). Nothing here is permission-aware: callers have already
 * decided who may act.
 */
@Injectable()
export class AccountsService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly mongo: MongoService,
  ) {}

  async create(data: NewUser): Promise<PublicUser> {
    try {
      const user = await this.users.create({
        role: UserRole.USER,
        status: AccountStatus.PENDING_EMAIL,
        accountVersion: 0,
        isProfessional: false,
        avoidedIngredientIds: [],
        avoidedGroupIds: [],
        likedIngredientIds: [],
        ...data,
      });
      return toPublicUser(user);
    } catch (error: unknown) {
      rethrowUniqueViolation(error);
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

  findByUsername(username: string): Promise<User | null> {
    return this.users.findOne({ username }).exec();
  }

  findByGoogleId(googleId: string): Promise<User | null> {
    return this.users.findOne({ googleId }).exec();
  }

  findByEmail(email: string): Promise<User | null> {
    return this.users.findOne({ email }).exec();
  }

  async findPublicById(id: string): Promise<PublicUser | null> {
    const user = await this.users
      .findOne({ _id: id })
      .select(publicUserProjection)
      .exec();
    return user && toPublicUser(user);
  }

  /**
   * Links Google to an existing account with the same email. If that account
   * never verified its email, anyone could have registered it, so its password
   * is removed and Google's verification takes over.
   */
  async linkGoogleAccount(user: User, googleId: string): Promise<PublicUser> {
    try {
      const linked = await this.users
        .findOneAndUpdate(
          {
            _id: user.id,
            status: {
              $in: [AccountStatus.ACTIVE, AccountStatus.PENDING_EMAIL],
            },
          },
          {
            $set: user.emailVerifiedAt
              ? { googleId, status: AccountStatus.ACTIVE }
              : {
                  googleId,
                  passwordHash: null,
                  emailVerifiedAt: new Date(),
                  status: AccountStatus.ACTIVE,
                },
          },
          { returnDocument: 'after' },
        )
        .exec();
      if (!linked) throw new NotFoundException('User not found');
      return toPublicUser(linked);
    } catch (error: unknown) {
      rethrowUniqueViolation(error);
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
    await this.mongo.withTransaction((session) =>
      deleteWithReferences(this.mongo.db, session, 'users', {
        $or: [{ email }, { username }],
        emailVerifiedAt: null,
        googleId: null,
        role: UserRole.USER,
        status: AccountStatus.PENDING_EMAIL,
        createdAt: { $lt: createdBefore },
      }),
    );
  }
}
