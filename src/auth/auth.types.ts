import type { Request } from 'express';
import type { UserRole } from '../mongo/models';

export interface JwtPayload {
  sub: string;
  username: string;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

export interface OptionalAuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/** Current account permissions, loaded from the database by JwtAuthGuard. */
export interface AuthenticatedUser extends JwtPayload {
  role: UserRole;
}
