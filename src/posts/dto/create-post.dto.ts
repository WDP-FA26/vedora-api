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

export const MAX_POST_BODY_WORDS = 250;
/** Only bounds a body of very long "words"; 250 ordinary words fit easily. */
export const MAX_POST_BODY_LENGTH = 2000;
export const MAX_POST_MEDIA = 4;

/** Runs of non-whitespace, the way the composer counts them. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function MaxWords(max: number, options?: ValidationOptions) {
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
