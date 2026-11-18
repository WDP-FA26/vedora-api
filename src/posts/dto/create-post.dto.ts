import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PostType } from '../../mongo/models.js';
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
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';

export const MAX_POST_BODY_WORDS = runtimeConfig.POST_MAX_WORDS;
export const MAX_POST_BODY_LENGTH = runtimeConfig.POST_MAX_LENGTH;
export const MAX_POST_MEDIA = runtimeConfig.POST_MAX_MEDIA;

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function MaxWords(max: number, options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'maxWords',
      constraints: [max],
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && countWords(value) <= max,
        defaultMessage: () => `$property must be at most ${max} words`,
      },
    },
    options,
  );
}

export class CreatePostDto {
  @ApiProperty({
    enum: [PostType.POST],
    description: 'Create short posts here; use POST /blogs for long articles.',
  })
  @IsIn([PostType.POST])
  type!: PostType;

  @ApiPropertyOptional({
    maxLength: MAX_POST_BODY_LENGTH,
    description: `Plain text, at most ${MAX_POST_BODY_WORDS} words (split on whitespace) and ${MAX_POST_BODY_LENGTH} characters after trimming`,
  })
  @Transform(({ value }) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() : input;
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_POST_BODY_LENGTH)
  @MaxWords(MAX_POST_BODY_WORDS)
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
