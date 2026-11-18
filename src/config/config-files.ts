import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadTextConfig(file: string): string {
  try {
    const value = readFileSync(resolve(file), 'utf8');
    if (!value.trim()) throw new Error('empty file');
    return value;
  } catch {
    throw new Error(`Config file cannot be read or is empty: ${file}`);
  }
}

export function loadJsonConfig<T>(
  file: string,
  validate: (value: unknown) => boolean,
): T {
  let value: unknown;
  try {
    value = JSON.parse(loadTextConfig(file));
  } catch {
    throw new Error(`Invalid JSON config file: ${file}`);
  }
  if (!validate(value))
    throw new Error(`Invalid config file structure: ${file}`);
  return value as T;
}

export function validDecisionPolicy(
  value: unknown,
  expectedKeys: readonly string[],
): boolean {
  if (!value || typeof value !== 'object') return false;
  const policy = value as Record<string, unknown>;
  if (
    policy.type !== 'choice' ||
    typeof policy.instructions !== 'string' ||
    !policy.instructions.trim() ||
    !policy.criteria ||
    typeof policy.criteria !== 'object' ||
    Array.isArray(policy.criteria)
  )
    return false;
  const criteria = policy.criteria as Record<string, unknown>;
  return (
    Object.keys(criteria).length === expectedKeys.length &&
    expectedKeys.every(
      (key) =>
        typeof criteria[key] === 'string' && criteria[key].trim().length > 0,
    )
  );
}

export function validContentPolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const policy = value as Record<string, unknown>;
  if (
    typeof policy.instructions !== 'string' ||
    !policy.instructions.trim() ||
    typeof policy.allowDescription !== 'string' ||
    !policy.allowDescription.trim() ||
    !Array.isArray(policy.choices) ||
    !policy.choices.length
  )
    return false;
  const keys = new Set<string>();
  return policy.choices.every((value: unknown) => {
    if (!value || typeof value !== 'object') return false;
    const choice = value as Record<string, unknown>;
    if (
      ['key', 'label', 'description', 'reasonText'].some(
        (key) => typeof choice[key] !== 'string' || !choice[key].trim(),
      )
    )
      return false;
    const key = choice.key as string;
    if (key === 'allow' || !/^[a-z][a-z0-9_]{1,31}$/.test(key) || keys.has(key))
      return false;
    keys.add(key);
    return true;
  });
}
