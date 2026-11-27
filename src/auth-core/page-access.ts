import type { Model } from 'mongoose';
import type { User, WorkspaceMember } from '../mongo/models.js';
import { UnauthenticatedException } from '../common/exceptions/unauthenticated.exception.js';
import { assertAccountActive } from './account-access.js';

export async function assertPageAccess(
  users: Model<User>,
  members: Model<WorkspaceMember>,
  pageUserId: string,
  actorId: string,
): Promise<void> {
  const [actor, membership] = await Promise.all([
    users.findOne({ _id: actorId }).select('status').exec(),
    members.exists({ pageUserId, userId: actorId }).exec(),
  ]);
  if (!actor)
    throw new UnauthenticatedException(
      'UNAUTHORIZED',
      'Account no longer exists',
    );
  assertAccountActive(actor.status);
  if (!membership)
    throw new UnauthenticatedException(
      'PAGE_ACCESS_REVOKED',
      'You no longer manage this page',
    );
}
