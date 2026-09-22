import type { Request } from 'express';

export interface GoogleProfileUser {
  googleId: string;
  email: string;
  fullName: string;
}

export interface GoogleAuthenticatedRequest extends Request {
  user: GoogleProfileUser;
}
