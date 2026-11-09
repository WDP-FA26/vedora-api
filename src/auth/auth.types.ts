import type { Request } from 'express';
import type { UserRole } from '../mongo/models.js';

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

export interface AuthenticatedUser extends JwtPayload {
  role: UserRole;
}
