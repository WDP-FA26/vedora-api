import { AppException } from './app-exception.js';

/** A feature is switched off, unconfigured, or temporarily down. 503. */
export const FEATURE_UNAVAILABLE_CODES = [
  'SERVICE_UNAVAILABLE',
  'PAYMENTS_DISABLED',
  'PAYMENT_CODE_UNAVAILABLE',
  'GUEST_CHAT_CLOSED',
] as const;

export type FeatureUnavailableCode = (typeof FEATURE_UNAVAILABLE_CODES)[number];

export class FeatureUnavailableException extends AppException<FeatureUnavailableCode> {
  readonly statusCode = 503;
}
