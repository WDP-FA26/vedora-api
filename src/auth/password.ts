import { BadRequestException } from '@nestjs/common';
import { hash, truncates } from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  if (truncates(password)) {
    throw new BadRequestException('Password must not exceed 72 UTF-8 bytes');
  }
  return hash(password, BCRYPT_ROUNDS);
}
