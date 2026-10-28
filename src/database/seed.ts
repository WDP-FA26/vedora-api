import { randomUUID } from 'node:crypto';
import { compare, hash, truncates } from 'bcryptjs';
import { AccountStatus, UserRole, type User } from '../mongo/models';
import type { MongoService } from '../mongo/mongo.service';

export async function seedDatabase(mongo: MongoService): Promise<void> {
  const seedPassword = process.env.SEED_USER_PASSWORD;
  if (!seedPassword) {
    console.log('SEED_USER_PASSWORD is not set; skipping seed user.');
    return;
  }
  if (truncates(seedPassword)) {
    throw new Error('SEED_USER_PASSWORD must not exceed 72 UTF-8 bytes.');
  }

  const users = mongo.connection.model<User>('User');
  const passwordHash = await hash(seedPassword, 12);
  const existingUser = await users.findOne({ email: 'admin@vedora.local' });

  if (existingUser) {
    // Never promote an account created by somebody squatting on the seed email.
    if (
      existingUser.username !== 'vedora.admin' ||
      !existingUser.emailVerifiedAt ||
      (existingUser.role !== UserRole.ADMIN &&
        (!existingUser.passwordHash ||
          !(await compare(seedPassword, existingUser.passwordHash))))
    ) {
      throw new Error(
        'Seed admin email belongs to an untrusted account; refusing to grant admin access.',
      );
    }
    await users.updateOne(
      { _id: existingUser.id },
      {
        $set: {
          username: 'vedora.admin',
          fullName: 'Vedora Admin',
          role: UserRole.ADMIN,
          emailVerifiedAt: existingUser.emailVerifiedAt ?? new Date(),
          ...(existingUser.passwordHash === '!migrated-user-has-no-password'
            ? { passwordHash }
            : {}),
        },
      },
    );
  } else {
    await users.create({
      _id: randomUUID(),
      username: 'vedora.admin',
      passwordHash,
      email: 'admin@vedora.local',
      fullName: 'Vedora Admin',
      role: UserRole.ADMIN,
      // admin@vedora.local can't receive mail.
      emailVerifiedAt: new Date(),
      status: AccountStatus.ACTIVE,
      accountVersion: 0,
      isProfessional: false,
      avoidedIngredientIds: [],
      avoidedGroupIds: [],
      likedIngredientIds: [],
    });
  }
}
