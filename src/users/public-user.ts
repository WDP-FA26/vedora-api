import type { User } from '../mongo/models.js';

/** The account fields every response exposes. */
export const publicUserFields = [
  'id',
  'username',
  'fullName',
  'email',
  'role',
  'status',
  'accountVersion',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof User)[];

export type PublicUser = Pick<User, (typeof publicUserFields)[number]>;

/** The stored fields behind `publicUserFields` (`id` is the `_id` virtual). */
export const publicUserProjection = publicUserFields
  .filter((field) => field !== 'id')
  .join(' ');

export function toPublicUser(user: PublicUser): PublicUser {
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
