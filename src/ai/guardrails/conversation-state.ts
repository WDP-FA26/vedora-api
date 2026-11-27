import { runtimeConfig } from '../../config/runtime-config.js';
import { registerDecorator, type ValidationOptions } from 'class-validator';
import { InvalidInputException } from '../../common/exceptions/invalid-input.exception.js';

export interface ModerationTurn {
  role: 'user' | 'assistant';
  text: string;
}

const DEFAULT_MAX_MODERATION_CHARS =
  runtimeConfig.AI_MODERATION_CONTEXT_MAX_CHARS;

export function conversationModerationState(
  turns: readonly ModerationTurn[],
  maxChars: number = DEFAULT_MAX_MODERATION_CHARS,
): string | readonly { role: 'user' | 'assistant'; text: string }[] {
  if (turns.length === 0) return '';
  if (turns.length === 1 && turns[0].role === 'user') return turns[0].text;

  const selected: { role: 'user' | 'assistant'; text: string }[] = [];
  let remaining = maxChars;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (remaining <= 0 && selected.length > 0) break;
    const text =
      turn.text.length <= remaining || selected.length === 0
        ? turn.text.slice(0, Math.max(remaining, 0))
        : turn.text.slice(-remaining);
    if (!text) continue;
    selected.push({ role: turn.role, text });
    remaining -= text.length;
  }
  return selected.reverse();
}

function endsWithUserRole(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return true;
  const last: unknown = value[value.length - 1];
  return (
    typeof last === 'object' &&
    last !== null &&
    'role' in last &&
    last.role === 'user'
  );
}

export function LastMessageFromUser(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'lastMessageFromUser',
      target: object.constructor,
      propertyName,
      options: {
        message: 'The last message must come from the user',
        ...options,
      },
      validator: {
        validate: (value: unknown) => endsWithUserRole(value),
      },
    });
  };
}

export function assertLastMessageFromUser(
  messages: readonly { role: string }[],
): void {
  if (messages.length > 0 && messages[messages.length - 1].role !== 'user') {
    throw new InvalidInputException(
      'BAD_REQUEST',
      'The last message must come from the user',
    );
  }
}
