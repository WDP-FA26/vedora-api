import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { CursorPaginatedResponseDto } from '../../common/pagination/index.js';
import { PostAuthorDto } from '../../common/dto/post-author.dto.js';

export const MAX_COMMENT_BODY_LENGTH = runtimeConfig.COMMENT_MAX_LENGTH;

export class CommentBodyDto {
  @ApiProperty({ maxLength: MAX_COMMENT_BODY_LENGTH, minLength: 1 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_COMMENT_BODY_LENGTH)
  body!: string;
}

export class CommentAuthorDto extends PostAuthorDto {
  /**
   * True for Vedora AI, the system account behind automatic summaries. It has
   * no profile page, so clients should not link to one.
   */
  @ApiProperty()
  isSystem!: boolean;
}

export class CommentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  postId!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  parentId!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  replyToId!: string | null;

  @ApiProperty({ type: CommentAuthorDto, nullable: true })
  replyToAuthor!: CommentAuthorDto | null;

  @ApiProperty({ minimum: 0 })
  replyCount!: number;

  @ApiProperty()
  body!: string;

  @ApiProperty({ type: CommentAuthorDto })
  author!: CommentAuthorDto;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class CommentPageDto extends CursorPaginatedResponseDto<CommentResponseDto> {
  @ApiProperty({ type: [CommentResponseDto] })
  declare items: CommentResponseDto[];
}
