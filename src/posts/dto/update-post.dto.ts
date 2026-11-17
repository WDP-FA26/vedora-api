import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength } from 'class-validator';
import {
  MAX_POST_BODY_LENGTH,
  MAX_POST_BODY_WORDS,
  MaxWords,
} from './create-post.dto.js';

export class UpdatePostDto {
  @ApiProperty({
    maxLength: MAX_POST_BODY_LENGTH,
    description: `New plain text, at most ${MAX_POST_BODY_WORDS} words and ${MAX_POST_BODY_LENGTH} characters after trimming. An empty string removes the text, which a post with a video allows. The attached videos cannot be changed.`,
  })
  @Transform(({ value }) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() : input;
  })
  @IsString()
  @MaxLength(MAX_POST_BODY_LENGTH)
  @MaxWords(MAX_POST_BODY_WORDS)
  body!: string;
}
