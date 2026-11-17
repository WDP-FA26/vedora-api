import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ConversationsQueryDto,
  MAX_MESSAGE_LENGTH,
  MessagingInbox,
  ReadConversationDto,
  SendMessageDto,
} from '../../../src/messaging/dto/messaging.dto.js';

const validUuid = '00000000-0000-4000-8000-000000000001';

describe('messaging DTOs', () => {
  describe('ConversationsQueryDto', () => {
    it('defaults box to FRIENDS and limit to 20', async () => {
      const dto = plainToInstance(ConversationsQueryDto, {});
      expect(dto.box).toBe(MessagingInbox.FRIENDS);
      expect(dto.limit).toBe(20);
      await expect(validate(dto)).resolves.toHaveLength(0);
    });

    it('accepts requests box and valid cursor/limit', async () => {
      const dto = plainToInstance(ConversationsQueryDto, {
        box: MessagingInbox.REQUESTS,
        cursor: validUuid,
        limit: 50,
      });
      await expect(validate(dto)).resolves.toHaveLength(0);
    });

    it('rejects unknown box or invalid cursor', async () => {
      const badBox = plainToInstance(ConversationsQueryDto, { box: 'spam' });
      const badCursor = plainToInstance(ConversationsQueryDto, {
        cursor: 'not-a-uuid',
      });
      await expect(validate(badBox)).resolves.not.toHaveLength(0);
      await expect(validate(badCursor)).resolves.not.toHaveLength(0);
    });
  });

  describe('SendMessageDto', () => {
    it('trims body whitespace and accepts up to MAX_MESSAGE_LENGTH chars', async () => {
      const dto = plainToInstance(SendMessageDto, {
        clientMessageId: validUuid,
        body: `  ${'a'.repeat(MAX_MESSAGE_LENGTH)}  `,
      });
      expect(dto.body).toHaveLength(MAX_MESSAGE_LENGTH);
      await expect(validate(dto)).resolves.toHaveLength(0);
    });

    it('rejects whitespace-only, empty, non-string, or oversized bodies', async () => {
      for (const body of ['   ', '', 123, 'a'.repeat(MAX_MESSAGE_LENGTH + 1)]) {
        const dto = plainToInstance(SendMessageDto, {
          clientMessageId: validUuid,
          body,
        });
        await expect(validate(dto)).resolves.not.toHaveLength(0);
      }
    });

    it('rejects non-UUIDv4 clientMessageId', async () => {
      const dto = plainToInstance(SendMessageDto, {
        clientMessageId: '1234',
        body: 'Hello',
      });
      await expect(validate(dto)).resolves.not.toHaveLength(0);
    });
  });

  describe('ReadConversationDto', () => {
    it('requires a UUID v4 messageId', async () => {
      await expect(
        validate(plainToInstance(ReadConversationDto, { messageId: validUuid })),
      ).resolves.toHaveLength(0);

      await expect(
        validate(
          plainToInstance(ReadConversationDto, { messageId: 'bad-id' }),
        ),
      ).resolves.not.toHaveLength(0);
    });
  });
});
