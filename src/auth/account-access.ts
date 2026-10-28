import { AccountStatus } from '../mongo/models.js';
import { UnauthenticatedException } from '../common/exceptions/unauthenticated.exception.js';

export function assertAccountActive(status: AccountStatus): void {
  if (status !== AccountStatus.ACTIVE) {
    throw new UnauthenticatedException(
      status === AccountStatus.SUSPENDED
        ? 'ACCOUNT_SUSPENDED'
        : 'ACCOUNT_NOT_ACTIVE',
      'Account is not active',
    );
  }
}
