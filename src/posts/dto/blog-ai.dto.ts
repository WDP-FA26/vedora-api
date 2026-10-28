import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AiFeature } from '../../mongo/models';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MAX_BLOG_CONTENT } from './blog.dto';

export const MAX_ASSISTANT_MESSAGES = 40;
export const MAX_SELECTION = 4000;

export class EditorSnapshotDto {
  @ApiProperty({ maxLength: 150, description: 'May be empty' })
  @IsString()
  @MaxLength(150)
  title!: string;

  @ApiProperty({ maxLength: MAX_BLOG_CONTENT, description: 'Markdown draft' })
  @IsString()
  @MaxLength(MAX_BLOG_CONTENT)
  content!: string;

  @ApiPropertyOptional({
    maxLength: MAX_SELECTION,
    description: 'The text currently selected in the editor',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SELECTION)
  selection?: string;
}

export class BlogAssistantChatDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    maxItems: MAX_ASSISTANT_MESSAGES,
    description:
      "`useChat` UI messages, oldest first, including tool parts. Checked against the assistant's tools. The last one is a user message, or the assistant message whose editor tools all have outputs.",
    example: [
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Viết lại đoạn này cho mượt hơn' }],
      },
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ASSISTANT_MESSAGES)
  @IsObject({ each: true })
  messages!: unknown[];

  @ApiProperty({ type: EditorSnapshotDto })
  @ValidateNested()
  @Type(() => EditorSnapshotDto)
  editor!: EditorSnapshotDto;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      "Your blog being edited, if already saved: its linked recipes ground the assistant's facts",
  })
  @IsOptional()
  @IsUUID()
  blogId?: string;

  // sent by `DefaultChatTransport` alongside the messages
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) id?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  trigger?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  messageId?: string;
}

export class AiQuotaDto {
  @ApiProperty({ enum: AiFeature }) feature!: AiFeature;
  @ApiProperty() used!: number;
  @ApiProperty() limit!: number;
  @ApiProperty({ description: 'Next midnight in Asia/Bangkok' })
  resetsAt!: Date;
}

export class BlogAssistantQuotaDto {
  @ApiProperty({ type: AiQuotaDto, description: 'Requests to the assistant' })
  messages!: AiQuotaDto;
  @ApiProperty({ type: AiQuotaDto, description: 'Generated or edited images' })
  images!: AiQuotaDto;
}
