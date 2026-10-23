import { randomInt } from 'node:crypto';

export function generatePaymentCode(prefix: string): string {
  // randomInt is uniform; padding preserves leading zeroes in the fixed suffix.
  return (
    prefix +
    randomInt(36 ** 6)
      .toString(36)
      .padStart(6, '0')
      .toUpperCase()
  );
}
