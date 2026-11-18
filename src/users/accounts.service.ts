import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { hashPassword } from '../auth-core/password.js';
import { AccountStatus, User, UserRole } from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { ProfileSearchIndexService } from '../profiles/search/profile-search-index.service.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import {
  type PublicUser,
  publicUserProjection,
  toPublicUser,
} from './public-user.js';
import { rethrowUniqueViolation } from './unique-conflict.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';

export type NewUser = Pick<User, 'username' | 'fullName' | 'email'> &
  Partial<
    Pick<User, 'passwordHash' | 'googleId' | 'emailVerifiedAt' | 'status'>
  >;

@Injectable()
export class AccountsService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly mongo: MongoService,
    @Optional() private readonly profileSearchIndex?: ProfileSearchIndexService,
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
      if (user.status === AccountStatus.ACTIVE && user.emailVerifiedAt) {
        this.profileSearchIndex?.schedule();
      }
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
      if (!linked)
        throw new ResourceNotFoundException('NOT_FOUND', 'User not found');
      this.profileSearchIndex?.schedule();
      return toPublicUser(linked);
    } catch (error: unknown) {
      rethrowUniqueViolation(error);
    }
  }

  async deleteStaleUnverified(
    { email, username }: { email: string; username: string },
    createdBefore: Date,
  ): Promise<void> {
    await this.mongo.withTransaction((session) =>
      this.users
        .deleteMany(
          {
            $or: [{ email }, { username }],
            emailVerifiedAt: null,
            googleId: null,
            role: UserRole.USER,
            status: AccountStatus.PENDING_EMAIL,
            createdAt: { $lt: createdBefore },
          },
          { session },
        )
        .exec(),
    );
  }
}
