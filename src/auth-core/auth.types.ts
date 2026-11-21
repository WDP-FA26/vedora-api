import type { Request } from 'express';
import type { UserRole } from '../mongo/models.js';

export interface JwtPayload {
  sub: string;
  username: string;
  /** Set on a page session: the member acting as the page in `sub`. */
  act?: string;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

export interface OptionalAuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

export interface AuthenticatedUser {
  /** The account the request acts as: a person, or a page in a page session. */
  sub: string;
  username: string;
  role: UserRole;
  /** The person behind a page session; null when acting as yourself. */
  actorId: string | null;
}
