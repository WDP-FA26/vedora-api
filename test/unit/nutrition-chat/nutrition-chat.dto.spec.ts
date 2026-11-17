import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ChatMessageDto,
  CreateGuestSessionDto,
  NutritionChatDto,
} from '../../../src/nutrition-chat/dto/nutrition-chat.dto.js';

describe('NutritionChat DTOs', () => {
  describe('ChatMessageDto & NutritionChatDto', () => {
    it('accepts valid conversation turns up to 5 messages ending with user', async () => {
      const dto = plainToInstance(NutritionChatDto, {
        messages: [
          { role: 'user', text: 'Đậu phụ có canxi không?' },
          { role: 'assistant', text: 'Có nhiều canxi.' },
          { role: 'user', text: 'Ăn bao nhiêu mỗi ngày?' },
        ],
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.messages[0]).toBeInstanceOf(ChatMessageDto);
    });

    it('rejects a conversation ending with an assistant turn', async () => {
      const dto = plainToInstance(NutritionChatDto, {
        messages: [
          { role: 'user', text: 'Đậu phụ có canxi không?' },
          { role: 'assistant', text: 'Có nhiều canxi.' },
        ],
      });
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('rejects empty messages array or more than 5 messages', async () => {
      const empty = plainToInstance(NutritionChatDto, { messages: [] });
      expect(await validate(empty)).not.toHaveLength(0);

      const tooMany = plainToInstance(NutritionChatDto, {
        messages: Array.from({ length: 6 }, () => ({
          role: 'user',
          text: 'Hi',
        })),
      });
      expect(await validate(tooMany)).not.toHaveLength(0);
    });

    it('rejects invalid role, empty text, or text exceeding 2000 chars', async () => {
      const badRole = plainToInstance(NutritionChatDto, {
        messages: [{ role: 'system', text: 'hi' }],
      });
      expect(await validate(badRole)).not.toHaveLength(0);

      const emptyText = plainToInstance(NutritionChatDto, {
        messages: [{ role: 'user', text: '' }],
      });
      expect(await validate(emptyText)).not.toHaveLength(0);

      const longText = plainToInstance(NutritionChatDto, {
        messages: [{ role: 'user', text: 'a'.repeat(2001) }],
      });
      expect(await validate(longText)).not.toHaveLength(0);
    });
  });

  describe('CreateGuestSessionDto', () => {
    it('accepts a valid turnstile token', async () => {
      const dto = plainToInstance(CreateGuestSessionDto, {
        turnstileToken: 'cf-token-123',
      });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects empty or overly long turnstile token', async () => {
      expect(
        await validate(
          plainToInstance(CreateGuestSessionDto, { turnstileToken: '' }),
        ),
      ).not.toHaveLength(0);

      expect(
        await validate(
          plainToInstance(CreateGuestSessionDto, {
            turnstileToken: 'x'.repeat(2049),
          }),
        ),
      ).not.toHaveLength(0);
    });
  });
});
