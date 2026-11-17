import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  assertLastMessageFromUser,
  conversationModerationState,
  LastMessageFromUser,
} from '../../../../src/ai/guardrails/conversation-state.js';
import { InvalidInputException } from '../../../../src/common/exceptions/invalid-input.exception.js';

class SampleChatDto {
  @LastMessageFromUser()
  messages!: { role: string; text: string }[];
}

describe('conversation-state guardrails', () => {
  it('formats single user turns as string and multi-turn conversations as ordered array', () => {
    expect(conversationModerationState([])).toBe('');
    expect(
      conversationModerationState([{ role: 'user', text: 'Xin chào' }]),
    ).toBe('Xin chào');
    expect(
      conversationModerationState([{ role: 'assistant', text: 'Chào bạn' }]),
    ).toEqual([{ role: 'assistant', text: 'Chào bạn' }]);

    expect(
      conversationModerationState([
        { role: 'user', text: 'T1' },
        { role: 'assistant', text: 'A1' },
        { role: 'user', text: 'T2' },
      ]),
    ).toEqual([
      { role: 'user', text: 'T1' },
      { role: 'assistant', text: 'A1' },
      { role: 'user', text: 'T2' },
    ]);
  });

  it('truncates oldest turns first when exceeding the character budget', () => {
    const result = conversationModerationState(
      [
        { role: 'user', text: 'oldest-turn' },
        { role: 'assistant', text: 'middle' },
        { role: 'user', text: 'latest' },
      ],
      10,
    );
    expect(result).toEqual([
      { role: 'assistant', text: 'ddle' },
      { role: 'user', text: 'latest' },
    ]);

    const hugeSingle = conversationModerationState(
      [
        { role: 'assistant', text: 'first' },
        { role: 'user', text: 'abcdefghij' },
      ],
      4,
    );
    expect(hugeSingle).toEqual([{ role: 'user', text: 'abcd' }]);
  });

  it('validates trailing user turn via @LastMessageFromUser and assertLastMessageFromUser', async () => {
    const valid = plainToInstance(SampleChatDto, {
      messages: [
        { role: 'user', text: 'Hi' },
        { role: 'assistant', text: 'Hello' },
        { role: 'user', text: 'More' },
      ],
    });
    expect(await validate(valid)).toHaveLength(0);

    const trailingAssistant = plainToInstance(SampleChatDto, {
      messages: [
        { role: 'user', text: 'Hi' },
        { role: 'assistant', text: 'Hello' },
      ],
    });
    const errors = await validate(trailingAssistant);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints?.lastMessageFromUser).toBe(
      'The last message must come from the user',
    );

    // Empty or non-array delegates to @ArrayMinSize/@IsArray
    expect(
      await validate(plainToInstance(SampleChatDto, { messages: [] })),
    ).toHaveLength(0);

    expect(() => assertLastMessageFromUser([])).not.toThrow();
    expect(() =>
      assertLastMessageFromUser([{ role: 'user' }]),
    ).not.toThrow();
    expect(() =>
      assertLastMessageFromUser([
        { role: 'user' },
        { role: 'assistant' },
      ]),
    ).toThrow(InvalidInputException);
  });
});
