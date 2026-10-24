import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { PostStatus } from '@prisma/client';
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
import { CursorPaginationQueryDto } from '../../common/pagination';
import { PostResponseDto } from './post-response.dto';

export const MAX_BLOG_CONTENT = 50_000;
export const MAX_BLOG_RECIPES = 10;
const BLOG_STATUSES = [PostStatus.DRAFT, PostStatus.PUBLISHED];
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateBlogDto {
  @ApiProperty({ maxLength: 150 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
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
    maxLength: 2048,
    format: 'uri',
    description:
      "An https image link, or an image in Vedora's blog storage (plain http outside production)",
  })
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @Transform(trim)
  // narrowed in BlogsService: http only for Vedora's own storage
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
  })
  @MaxLength(2048)
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
