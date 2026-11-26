import type { Model } from 'mongoose';
import type { User, WorkspaceMember } from '../mongo/models.js';
import { UnauthenticatedException } from '../common/exceptions/unauthenticated.exception.js';
import { assertAccountActive } from './account-access.js';
import { presentString } from '../mongo/partial-match.js';

/**
 * A page session is only valid while the person behind it is ACTIVE and
 * still a member of the page. Checked on every request and every refresh,
 * so removing a manager or suspending them ends their page session at once.
 */
export async function assertPageAccess(
  users: Model<User>,
  members: Model<WorkspaceMember>,
  pageUserId: string,
  actorId: string,
): Promise<void> {
  const [actor, membership] = await Promise.all([
    users.findOne({ _id: actorId }).select('status').exec(),
    members
      .exists({ pageUserId: presentString(pageUserId), userId: actorId })
      .exec(),
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
