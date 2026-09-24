import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PostType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const MAX_POST_BODY_LENGTH = 280;
export const MAX_POST_MEDIA = 1;

export class CreatePostDto {
  @ApiProperty({
    enum: [PostType.POST],
    description: 'Only POST for now; BLOG will be added with the Blog model.',
  })
  @IsIn([PostType.POST])
  type!: PostType;

  @ApiPropertyOptional({ maxLength: MAX_POST_BODY_LENGTH })
  @Transform(({ value }) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() : input;
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_POST_BODY_LENGTH)
  body?: string;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_POST_MEDIA,
    description: 'IDs from POST /media/uploads, in display order',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_POST_MEDIA)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  mediaIds?: string[];
}
