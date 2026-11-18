import { runtimeConfig } from '../config/runtime-config.js';
import { hash, truncates } from 'bcryptjs';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';

const BCRYPT_ROUNDS = runtimeConfig.AUTH_BCRYPT_ROUNDS;

export async function hashPassword(password: string): Promise<string> {
  if (truncates(password)) {
    throw new InvalidInputException(
      'BAD_REQUEST',
      'Password must not exceed 72 UTF-8 bytes',
    );
  }
  return hash(password, BCRYPT_ROUNDS);
}
