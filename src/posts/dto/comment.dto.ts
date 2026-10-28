import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { CursorPaginatedResponseDto } from '../../common/pagination/index.js';
import { PostAuthorDto } from './post-response.dto.js';

export const MAX_COMMENT_BODY_LENGTH = 1000;

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

export class CommentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  postId!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty({ type: PostAuthorDto })
  author!: PostAuthorDto;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class CommentPageDto extends CursorPaginatedResponseDto<CommentResponseDto> {
  @ApiProperty({ type: [CommentResponseDto] })
  declare items: CommentResponseDto[];
}
