import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';

export interface ValidationResult<T> {
  /** The payload as the DTO class, or null when any rule failed. */
  value: T | null;
  errors: string[];
}

/**
 * Validates a payload that did not come through `ValidationPipe`: a signed
 * webhook body, a Redis message, a provider response. Unknown properties are
 * stripped, as the global pipe does for request bodies.
 */
export function validatePayload<T extends object>(
  cls: ClassConstructor<T>,
  payload: unknown,
): ValidationResult<T> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    return { value: null, errors: ['payload must be an object'] };
  const instance = plainToInstance(cls, payload);
  const errors = validateSync(instance, {
    whitelist: true,
    forbidUnknownValues: false,
  });
  return {
    value: errors.length === 0 ? instance : null,
    errors: errorMessages(errors),
  };
}

function errorMessages(errors: ValidationError[], path = ''): string[] {
  return errors.flatMap((error) => {
    const name = path ? `${path}.${error.property}` : error.property;
    return [
      ...Object.values(error.constraints ?? {}).map(
        (message) => `${name}: ${message}`,
      ),
      ...errorMessages(error.children ?? [], name),
    ];
  });
}

/** `validatePayload`, throwing instead of returning the failures. */
export function parsePayload<T extends object>(
  cls: ClassConstructor<T>,
  payload: unknown,
): T {
  const { value, errors } = validatePayload(cls, payload);
  if (!value) throw new Error(`Invalid ${cls.name}: ${errors.join('; ')}`);
  return value;
}
