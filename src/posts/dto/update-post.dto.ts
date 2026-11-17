import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  MAX_POST_BODY_LENGTH,
  MAX_POST_BODY_WORDS,
  MAX_POST_MEDIA,
  MaxWords,
} from './create-post.dto.js';

export class UpdatePostDto {
  @ApiPropertyOptional({
    maxLength: MAX_POST_BODY_LENGTH,
    description: `New plain text, at most ${MAX_POST_BODY_WORDS} words and ${MAX_POST_BODY_LENGTH} characters after trimming. An empty string removes the text, which a post with a video allows. Left out, the text stays as it is.`,
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
    description:
      'The final list of videos, in display order: ids already on the post to keep, plus new ids from POST /media/uploads. Videos left out are removed. Left out, the videos stay as they are.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_POST_MEDIA)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  mediaIds?: string[];
}
