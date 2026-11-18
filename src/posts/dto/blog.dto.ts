import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { PostStatus } from '../../mongo/models.js';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { CursorPaginationQueryDto } from '../../common/pagination/index.js';
import { PostResponseDto } from './post-response.dto.js';

export const MAX_BLOG_CONTENT = runtimeConfig.BLOG_CONTENT_MAX_LENGTH;
export const MAX_BLOG_RECIPES = runtimeConfig.BLOG_MAX_RECIPES;
const BLOG_STATUSES = [PostStatus.DRAFT, PostStatus.PUBLISHED];
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateBlogDto {
  @ApiProperty({ maxLength: runtimeConfig.BLOG_TITLE_MAX_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(runtimeConfig.BLOG_TITLE_MAX_LENGTH)
  title!: string;

  @ApiPropertyOptional({
    maxLength: MAX_BLOG_CONTENT,
    description: 'Markdown source; may be empty for a draft',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(MAX_BLOG_CONTENT)
  content?: string;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: runtimeConfig.BLOG_COVER_URL_MAX_LENGTH,
    format: 'uri',
    deprecated: true,
    description:
      "Ignored: the cover is always the first image in `content`. Still validated (an image uploaded to Vedora's blog storage) so older clients get the same errors.",
  })
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @Transform(trim)
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
  })
  @MaxLength(runtimeConfig.BLOG_COVER_URL_MAX_LENGTH)
  coverImageUrl?: string | null;

  @ApiPropertyOptional({ enum: BLOG_STATUSES, default: PostStatus.DRAFT })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(BLOG_STATUSES)
  status?: 'DRAFT' | 'PUBLISHED';

  @ApiPropertyOptional({ type: [String], maxItems: MAX_BLOG_RECIPES })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(MAX_BLOG_RECIPES)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  recipeIds?: string[];
}

export class UpdateBlogDto extends PartialType(CreateBlogDto, {
  skipNullProperties: false,
}) {}

export class MyBlogsQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({ enum: BLOG_STATUSES })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(BLOG_STATUSES)
  status?: 'DRAFT' | 'PUBLISHED';
}

export class BlogDetailDto extends PostResponseDto {
  @ApiProperty({
    description: 'Markdown source; disable raw HTML when rendering',
  })
  content!: string;
  @ApiProperty() updatedAt!: Date;
}
