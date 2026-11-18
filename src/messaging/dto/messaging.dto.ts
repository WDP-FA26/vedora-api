import { runtimeConfig } from '../../config/runtime-config.js';
import { PostAuthorDto } from '../../common/dto/post-author.dto.js';
import { PostType } from '../../mongo/enums.js';
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

export const MAX_MESSAGE_LENGTH = runtimeConfig.MESSAGE_MAX_LENGTH;
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

export class SharePostDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Reuse this ID when retrying the same share to the same recipient',
  })
  @IsUUID('4')
  clientMessageId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'An existing PUBLISHED post or blog',
  })
  @IsUUID('4')
  postId!: string;
}

export class SharedPostDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: PostType }) type!: PostType;
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty() excerpt!: string;
  @ApiProperty({ type: String, nullable: true }) imageUrl!: string | null;
  @ApiProperty({ type: PostAuthorDto }) author!: PostAuthorDto;
}

export class DeleteMessageRequestDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Last message displayed when deleting; newer messages are preserved',
  })
  @IsUUID('4')
  throughMessageId!: string;
}

export class DeletedMessageRequestDto {
  @ApiProperty({ format: 'uuid' }) conversationId!: string;
  @ApiProperty({ minimum: 0 }) deletedThroughSequence!: number;
}

export class MessageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) conversationId!: string;
  @ApiProperty({ format: 'uuid' }) senderId!: string;
  @ApiProperty({ format: 'uuid' }) recipientId!: string;
  @ApiProperty({ format: 'uuid' }) clientMessageId!: string;
  @ApiProperty({ minimum: 1 }) sequence!: number;
  @ApiProperty() body!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) sharedPostId!:
    string | null;
  @ApiProperty({
    type: SharedPostDto,
    nullable: true,
    description:
      'Null when the referenced post is no longer public or no longer exists',
  })
  sharedPost!: SharedPostDto | null;
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

export class MessagingContactDto {
  @ApiProperty({ type: MessagingPeerDto }) peer!: MessagingPeerDto;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  conversationId!: string | null;
  @ApiProperty({ enum: MessagingInbox }) box!: MessagingInbox;
  @ApiProperty() followsPeer!: boolean;
  @ApiProperty() peerFollowsYou!: boolean;
  @ApiProperty() canSend!: boolean;
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
  @ApiProperty() canAcceptRequest!: boolean;
  @ApiProperty() canDeleteRequest!: boolean;
  @ApiProperty({ minimum: 0 }) deletedThroughSequence!: number;
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
