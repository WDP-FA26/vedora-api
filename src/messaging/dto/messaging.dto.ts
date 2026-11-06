import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  CursorPaginatedResponseDto,
  CursorPaginationQueryDto,
} from '../../common/pagination/index.js';

export const MAX_MESSAGE_LENGTH = 2000;
export enum MessagingInbox {
  FRIENDS = 'friends',
  REQUESTS = 'requests',
}

export class ConversationsQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({
    enum: MessagingInbox,
    default: MessagingInbox.FRIENDS,
  })
  @IsEnum(MessagingInbox)
  box: MessagingInbox = MessagingInbox.FRIENDS;
}

export class SendMessageDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Client-generated UUID v4; reuse it for retries of this exact message',
  })
  @IsUUID('4')
  clientMessageId!: string;

  @ApiProperty({ minLength: 1, maxLength: MAX_MESSAGE_LENGTH })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_MESSAGE_LENGTH)
  body!: string;
}

export class ReadConversationDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Newest message actually displayed to the viewer',
  })
  @IsUUID('4')
  messageId!: string;
}

export class MessageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) conversationId!: string;
  @ApiProperty({ format: 'uuid' }) senderId!: string;
  @ApiProperty({ format: 'uuid' }) recipientId!: string;
  @ApiProperty({ format: 'uuid' }) clientMessageId!: string;
  @ApiProperty({ minimum: 1 }) sequence!: number;
  @ApiProperty() body!: string;
  @ApiProperty() createdAt!: Date;
}

export class MessagePageDto extends CursorPaginatedResponseDto<MessageDto> {
  @ApiProperty({ type: [MessageDto] }) declare items: MessageDto[];
}

export class MessagingPeerDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() username!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ nullable: true, type: String }) avatarUrl!: string | null;
  @ApiProperty() isProfessional!: boolean;
}

export class ConversationPreviewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) senderId!: string;
  @ApiProperty() body!: string;
  @ApiProperty() createdAt!: Date;
}

export class ConversationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: MessagingPeerDto }) peer!: MessagingPeerDto;
  @ApiProperty({ enum: MessagingInbox }) box!: MessagingInbox;
  @ApiProperty({ enum: ['incoming', 'outgoing'], nullable: true })
  requestDirection!: 'incoming' | 'outgoing' | null;
  @ApiProperty() followsPeer!: boolean;
  @ApiProperty() peerFollowsYou!: boolean;
  @ApiProperty() canSend!: boolean;
  @ApiProperty({ type: ConversationPreviewDto, nullable: true })
  lastMessage!: ConversationPreviewDto | null;
  @ApiProperty({ minimum: 0 }) unreadCount!: number;
  @ApiProperty({ minimum: 0 }) myReadSequence!: number;
  @ApiProperty({ minimum: 0 }) peerReadSequence!: number;
}

export class ConversationPageDto extends CursorPaginatedResponseDto<ConversationDto> {
  @ApiProperty({ type: [ConversationDto] }) declare items: ConversationDto[];
}

export class SendMessageResponseDto {
  @ApiProperty({ format: 'uuid' }) conversationId!: string;
  @ApiProperty({ type: MessageDto }) message!: MessageDto;
}

export class ConversationReadDto {
  @ApiProperty({ format: 'uuid' }) conversationId!: string;
  @ApiProperty({ minimum: 0 }) readSequence!: number;
  @ApiProperty({ minimum: 0 }) unreadCount!: number;
}
