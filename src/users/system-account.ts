import { AccountStatus, UserRole, type User } from '../mongo/models.js';

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
