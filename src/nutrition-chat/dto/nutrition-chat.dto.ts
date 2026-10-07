import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

// the agent sees its instructions plus only the latest turns
const MAX_CHAT_MESSAGES = 5;
// assistant turns come back as context, so this also bounds a reply
const MAX_CHAT_MESSAGE_LENGTH = 2000;

export class ChatMessageDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @ApiProperty({ maxLength: MAX_CHAT_MESSAGE_LENGTH })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_CHAT_MESSAGE_LENGTH)
  text!: string;
}

export class NutritionChatDto {
  @ApiProperty({
    type: [ChatMessageDto],
    maxItems: MAX_CHAT_MESSAGES,
    description: 'The latest turns, oldest first, ending with the user',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CHAT_MESSAGES)
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages!: ChatMessageDto[];
}

export class CreateGuestSessionDto {
  @ApiProperty({ description: 'Token from the Cloudflare Turnstile widget' })
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  turnstileToken!: string;
}

export class GuestSessionDto {
  @ApiProperty({ description: 'Bearer token for `POST /nutrition-chat`' })
  token!: string;

  @ApiProperty({ description: 'Seconds until the token expires' })
  expiresIn!: number;

  @ApiProperty({ description: 'Messages this session may still send today' })
  remaining!: number;
}
