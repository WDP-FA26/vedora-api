import { UnauthorizedException } from '@nestjs/common';
import { AccountStatus } from '../mongo/models.js';

export function assertAccountActive(status: AccountStatus): void {
  if (status !== AccountStatus.ACTIVE) {
    throw new UnauthorizedException({
      statusCode: 401,
      error: 'Unauthorized',
      code:
        status === AccountStatus.SUSPENDED
          ? 'ACCOUNT_SUSPENDED'
          : 'ACCOUNT_NOT_ACTIVE',
      message: 'Account is not active',
    });
  }
}
