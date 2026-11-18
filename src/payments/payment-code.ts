import { runtimeConfig } from '../config/runtime-config.js';
import { randomInt } from 'node:crypto';

export function generatePaymentCode(prefix: string): string {
  return (
    prefix +
    randomInt(36 ** runtimeConfig.PAYMENT_CODE_SUFFIX_LENGTH)
      .toString(36)
      .padStart(runtimeConfig.PAYMENT_CODE_SUFFIX_LENGTH, '0')
      .toUpperCase()
  );
}
