import type { Request } from 'express';

export interface JwtPayload {
  sub: string;
  username: string;
}

export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}
