import { AccountStatus, UserRole, type User } from '../mongo/models.js';

/**
 * The built-in Vedora AI account that posts automatic summaries. Its id is
 * fixed so every service can recognise it without a lookup. It has status
 * SYSTEM (never ACTIVE), no password, no Google id, no verified email and an
 * email on the reserved `.invalid` TLD: no one can sign in as it, and its
 * profile, follows and messages all answer 404.
 */
export const SYSTEM_ACCOUNT_ID = '6b493b11-fba7-4907-9f6b-c55273f14c45';

export const SYSTEM_ACCOUNT: Pick<
  User,
  | 'username'
  | 'fullName'
  | 'email'
  | 'role'
  | 'status'
  | 'passwordHash'
  | 'googleId'
  | 'emailVerifiedAt'
  | 'isProfessional'
> = {
  username: 'vedora.ai',
  fullName: 'Vedora AI',
  email: 'vedora-ai@system.vedora.invalid',
  role: UserRole.USER,
  status: AccountStatus.SYSTEM,
  passwordHash: null,
  googleId: null,
  emailVerifiedAt: null,
  isProfessional: false,
};

export function isSystemAccount(userId: string): boolean {
  return userId === SYSTEM_ACCOUNT_ID;
}
