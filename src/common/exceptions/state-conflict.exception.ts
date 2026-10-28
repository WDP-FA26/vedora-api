import { AppException } from './app-exception.js';

/** The request conflicts with the current state of a resource. 409. */
export const STATE_CONFLICT_CODES = [
  'CONFLICT',
  'ALREADY_VERIFIED',
  'PROOF_NOT_UPLOADED',
  'REQUEST_PENDING',
  'MEAL_PLAN_INVALID',
  'ALREADY_REPORTED',
  'INVALID_ACCOUNT_TRANSITION',
  'ACCOUNT_VERSION_CONFLICT',
  'LAST_ACTIVE_ADMIN',
  'RULE_EXISTS',
  'NAME_TAKEN',
  'INGREDIENT_IN_USE',
  'IDEMPOTENCY_CONFLICT',
  'ACCOUNT_NOT_PAYABLE',
  'PENDING_PAYMENT_CONFLICT',
  'PAYMENT_NOT_PENDING',
  'CAPTURE_CONFLICT',
  'FAVORITE_CONFLICT',
  'RATING_CONFLICT',
  'MEAL_PLAN_CONFLICT',
] as const;

export type StateConflictCode = (typeof STATE_CONFLICT_CODES)[number];

export class StateConflictException extends AppException<StateConflictCode> {
  readonly statusCode = 409;
}
